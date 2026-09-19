import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import {
  createUpdateRun,
  finishUpdateRun,
  getUpdateRun,
  recordUpdateRunDiagnostics,
  recordUpdateRunStep,
  recordUpdateRunVerification,
} from "./update-run-ledger.js";
import { renderUpdateRunReport } from "./update-run-report.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => closeOpenClawStateDatabaseForTest());

it("keeps recovery observations atomic across a busy write without revising the failed outcome", () => {
  const env = { OPENCLAW_STATE_DIR: dirs.make("update-observation-atomic-") };
  const options = { env, busyTimeoutMs: 0 };
  const run = createUpdateRun({ trigger: "cli" }, options);
  recordUpdateRunVerification(
    run.runId,
    {
      booted: true,
      noticeDelivered: true,
      doctorHint: "run doctor",
      serviceRunning: true,
      channelsReady: true,
      pluginErrors: [],
      runningVersion: "2026.9.5",
      versionMatch: true,
      readyz: true,
      settled: true,
      recovery: { serviceRestartSafe: false, reason: "state-migration-started" },
    },
    options,
  );
  recordUpdateRunStep(
    run.runId,
    { step: "gateway recovery verification", status: "completed", exitCode: 0 },
    options,
  );
  finishUpdateRun(run.runId, { status: "failed", reason: "doctor-failed" }, options);
  const before = getUpdateRun(run.runId, options);
  expect(before?.confirmedAtMs).toEqual(expect.any(Number));
  const warn = vi.fn();
  const recordPending = () =>
    recordUpdateRunDiagnostics(
      run.runId,
      (recorded) => ({
        recovery: recorded.recovery,
        observation: {
          verification: { readyz: false, settled: false },
          steps: [{ step: "gateway recovery verification", status: "completed", exitCode: null }],
        },
      }),
      warn,
      options,
    );
  const writer = new DatabaseSync(resolveOpenClawStateSqlitePath(env));
  try {
    writer.exec("BEGIN IMMEDIATE");
    recordPending();
    expect(warn).toHaveBeenCalledOnce();
    expect(getUpdateRun(run.runId, options)).toEqual(before);
  } finally {
    writer.exec("ROLLBACK");
    writer.close();
  }
  warn.mockClear();
  recordPending();
  expect(warn).not.toHaveBeenCalled();
  const after = getUpdateRun(run.runId, options);
  expect(after).toMatchObject({
    status: "failed",
    reason: "doctor-failed",
    confirmedAtMs: null,
    verification: {
      booted: true,
      noticeDelivered: true,
      doctorHint: "run doctor",
      readyz: false,
      settled: false,
      recovery: { serviceRestartSafe: false, reason: "state-migration-started" },
    },
  });
  expect(after?.verification.runningVersion).toBeUndefined();
  expect(
    after?.steps.find((step) => step.step === "gateway recovery verification")?.exitCode,
  ).toBeNull();
  expect(renderUpdateRunReport(after!).markdown).not.toContain("verified serving");
});
