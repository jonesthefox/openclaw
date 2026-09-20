import assert from "node:assert/strict";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { WorkerTaskError } from "../../infra/worker-task-pool.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { SessionMetadataUnavailableError } from "../../state/session-metadata-unavailable-error.js";
import { SessionTranscriptColdError } from "./session-cold-storage-state.js";
import { SessionTranscriptProjectionUnavailableError } from "./session-transcript-projection-error.js";
import { SessionTranscriptReadFenceError } from "./session-transcript-read-fence.js";
import { withSessionHistoryWorkerDatabase } from "./session-transcript-worker-runtime.js";

type Request = {
  input: unknown;
  taskId: number;
  nativeSections: SharedArrayBuffer;
};
type Resource = { close: () => Promise<void> };
const observed = vi.hoisted(() => ({
  handler: undefined as ((input: unknown) => unknown) | undefined,
  receive: undefined as ((message: Request) => void) | undefined,
  post: vi.fn<(message: unknown) => void>(),
  read: vi.fn<() => unknown>(),
  close: vi.fn<() => void>(),
  run: vi.fn<() => Promise<unknown>>(),
  rotate: vi.fn<() => Promise<void>>(),
  unregister: vi.fn<() => void>(),
  resources: [] as Resource[],
  nativeWorker: vi.fn(() => {
    throw new Error("Native workers are forbidden in these pure controls");
  }),
}));

vi.mock("node:worker_threads", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:worker_threads")>()),
  Worker: observed.nativeWorker,
  parentPort: {
    on: (_event: string, receive: (message: Request) => void) => {
      observed.receive = receive;
    },
    postMessage: (message: unknown) => observed.post(message),
  },
}));
vi.mock("../../infra/runtime-worker-url.js", () => ({
  resolveRuntimeWorkerUrl: () => new URL("file:///synthetic/session-history.worker.mjs"),
  resolveRuntimeWorkerArgv: () => [],
  resolveRuntimeWorkerThreadExecArgv: () => [],
}));
vi.mock("../../infra/worker-task-pool.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../infra/worker-task-pool.js")>();
  return {
    ...actual,
    WorkerTaskPool: class {
      run(prepare: () => unknown) {
        prepare();
        return observed.run();
      }
      rotate() {
        return observed.rotate();
      }
    },
  };
});
vi.mock("../../infra/worker-task-server.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../infra/worker-task-server.js")>();
  return {
    ...actual,
    serveWorkerTasks: (handler: (input: unknown) => unknown) => {
      observed.handler = handler;
      actual.serveWorkerTasks(handler);
    },
  };
});
vi.mock("../../state/openclaw-agent-db-resources.js", () => ({
  registerOpenClawAgentDatabaseAsyncResource: (resource: Resource) => {
    observed.resources.push(resource);
    return observed.unregister;
  },
}));
vi.mock("../../state/openclaw-agent-db-readonly-scope.js", () => ({
  OpenClawAgentDatabaseReadOnlyScope: class {
    hasRetainedConnection = true;
    run(_database: unknown, operation: () => unknown) {
      return operation();
    }
    close() {
      observed.close();
    }
  },
}));
vi.mock("./session-accessor.sqlite-entry.js", () => ({
  loadSessionEntryReadOnlyInScope: () => observed.read(),
}));
vi.mock("./session-sharing-store.js", () => ({
  listSessionMembers: () => {
    throw new Error("Native membership reads are forbidden in these pure controls");
  },
}));

await import("./session-transcript.worker.js");
let sequence = 0;
function input() {
  const database = { agentId: "main", path: `/synthetic/session-read-errors-${++sequence}.sqlite` };
  return {
    kind: "session-row-presence",
    database,
    scope: {
      agentId: "main",
      databaseAgentId: "main",
      sessionKey: "agent:main:errors",
      storePath: database.path,
    },
  };
}
function invoke(request: ReturnType<typeof input>) {
  assert(observed.handler);
  return Promise.resolve(observed.handler(request));
}

async function readThroughWorker() {
  const request = input();
  observed.run.mockImplementation(async () => {
    const posted = createDeferredCore<unknown>();
    observed.post.mockImplementation(posted.resolve);
    assert(observed.receive);
    observed.receive({ input: request, taskId: 7, nativeSections: new SharedArrayBuffer(4) });
    const reply = await posted.promise;
    assert(reply && typeof reply === "object" && "status" in reply);
    if (reply.status === "failed") {
      assert("error" in reply && typeof reply.error === "string");
      throw new WorkerTaskError(reply.error, "failed");
    }
    assert(reply.status === "ok" && "value" in reply);
    return structuredClone(reply.value);
  });
  return await withSessionHistoryWorkerDatabase(request.database, (owner) =>
    owner.readEntryPresence(request.scope),
  );
}

beforeEach(() => {
  observed.post.mockReset();
  observed.read.mockReset();
  observed.close.mockReset();
  observed.run.mockReset();
  observed.rotate.mockReset().mockResolvedValue(undefined);
  observed.unregister.mockReset();
});
afterEach(async () => {
  observed.rotate.mockResolvedValue(undefined);
  await Promise.all(observed.resources.splice(0).map((resource) => resource.close()));
  expect(observed.nativeWorker).not.toHaveBeenCalled();
});

it("preserves the worker read failure through transfer when closing succeeds", async () => {
  const primary = new Error("read failed");
  observed.read.mockImplementation(() => {
    throw primary;
  });
  await expect(readThroughWorker()).rejects.toMatchObject({ message: primary.message });
  expect(observed.close).toHaveBeenCalledTimes(1);
});

it("retains both worker errors through transfer when the read and close fail", async () => {
  const primary = new Error("read failed");
  const cleanup = new Error("database close failed");
  observed.read.mockImplementation(() => {
    throw primary;
  });
  observed.close.mockImplementation(() => {
    throw cleanup;
  });
  const failure: unknown = await readThroughWorker().catch((error: unknown) => error);
  assert(failure instanceof AggregateError);
  expect(failure.errors).toMatchObject([
    { message: primary.message },
    { message: cleanup.message },
  ]);
  expect(failure.cause).toBe(failure.errors[1]);
  expect(failure.message).toContain(primary.message);
  expect(failure.message).toContain(cleanup.message);
});

const typedFailures = [
  {
    error: new SessionTranscriptColdError("cold-session"),
    reply: { kind: "cold", sessionId: "cold-session" },
  },
  {
    error: new SessionTranscriptProjectionUnavailableError("projected-session"),
    reply: { kind: "projection", sessionId: "projected-session" },
  },
  {
    error: new SessionTranscriptReadFenceError("fence failed"),
    reply: { kind: "fence", message: "fence failed" },
  },
];
it.each(typedFailures)(
  "keeps typed $reply.kind recovery when closing succeeds",
  async ({ error, reply }) => {
    observed.read.mockImplementation(() => {
      throw error;
    });
    await expect(invoke(input())).resolves.toEqual({ ok: false, error: reply });
    expect(observed.close).toHaveBeenCalledTimes(1);
  },
);
it.each(typedFailures)(
  "does not recover typed $reply.kind reads when close also fails",
  async ({ error }) => {
    const cleanup = new Error("close failed");
    observed.read.mockImplementation(() => {
      throw error;
    });
    observed.close.mockImplementation(() => {
      throw cleanup;
    });
    const failure: unknown = await readThroughWorker().catch((caught: unknown) => caught);
    assert(failure instanceof AggregateError);
    expect(failure.errors).toMatchObject([
      { name: error.name, message: error.message },
      { message: cleanup.message },
    ]);
    expect(failure.cause).toBe(failure.errors[1]);
  },
);

it.each([false, true])(
  "retains typed metadata refusal and SQLite cause across worker transfer with cleanup failure=%s",
  async (fails) => {
    const cause = Object.assign(new Error("synthetic SQLite read failure"), {
      code: "ERR_SQLITE_ERROR",
      errcode: 1,
    });
    const primary = new SessionMetadataUnavailableError("table-missing", { cause }, [
      "transcript_events",
    ]);
    const cleanup = new Error("synthetic database close failure");
    observed.read.mockImplementation(() => {
      throw primary;
    });
    if (fails) {
      observed.close.mockImplementation(() => {
        throw cleanup;
      });
    }
    const failure: unknown = await readThroughWorker().catch((error: unknown) => error);
    const unavailable: unknown = failure instanceof AggregateError ? failure.errors[0] : failure;
    expect(unavailable).toBeInstanceOf(SessionMetadataUnavailableError);
    expect(unavailable).toMatchObject({
      reason: "table-missing",
      missingTables: ["transcript_events"],
      cause: { message: cause.message, code: "ERR_SQLITE_ERROR", errcode: 1 },
    });
    if (fails) {
      assert(failure instanceof AggregateError);
      expect(failure.errors[1]).toMatchObject({ message: cleanup.message });
      expect(failure.cause).toBe(failure.errors[1]);
    }
  },
);

it.each([false, true])(
  "awaits retirement and preserves both failures when retirement fails=%s",
  async (fails) => {
    const primary = new WorkerTaskError("worker response failed", "failed");
    const cleanup = new Error("retirement failed");
    const entered = createDeferredCore();
    const retirement = createDeferredCore();
    observed.run.mockRejectedValue(primary);
    observed.rotate.mockImplementation(() => {
      entered.resolve();
      return retirement.promise;
    });
    const request = input();
    let settled = false;
    const pending = withSessionHistoryWorkerDatabase(request.database, (owner) =>
      owner.readEntryPresence(request.scope),
    )
      .catch((error: unknown) => error)
      .finally(() => {
        settled = true;
      });
    await entered.promise;
    expect(settled).toBe(false);
    expect(observed.unregister).not.toHaveBeenCalled();
    if (fails) {
      retirement.reject(cleanup);
    } else {
      retirement.resolve();
    }
    const failure: unknown = await pending;
    if (fails) {
      assert(failure instanceof AggregateError);
      expect(failure.errors).toEqual([primary, cleanup]);
      expect(failure.cause).toBe(cleanup);
      expect(failure.message).toContain(primary.message);
      expect(failure.message).toContain(cleanup.message);
      expect(observed.unregister).not.toHaveBeenCalled();
    } else {
      expect(failure).toBe(primary);
      expect(observed.unregister).toHaveBeenCalledTimes(1);
    }
  },
);

it.each(typedFailures)(
  "preserves typed $reply.kind errors after successful parent retirement",
  async ({ error, reply }) => {
    observed.run.mockResolvedValue({ ok: false, error: reply });
    const request = input();
    const failure: unknown = await withSessionHistoryWorkerDatabase(request.database, (owner) =>
      owner.readEntryPresence(request.scope),
    ).catch((caught: unknown) => caught);
    expect(failure).toBeInstanceOf(error.constructor);
    expect(failure).toMatchObject({ message: error.message });
    expect(observed.rotate).toHaveBeenCalledTimes(1);
  },
);
