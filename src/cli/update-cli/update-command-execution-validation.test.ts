// Install the fixture mocks before loading the execution owner and its dependencies.
import "./update-command-execution.test-support.js";
import { once } from "node:events";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import * as configFile from "../../config/config.js";
import * as gatewayService from "../../daemon/service.js";
import * as gatewayCall from "../../gateway/call.js";
import { gatewayHealthResponse } from "../../gateway/health-response.test-support.js";
import * as portInspection from "../../infra/ports-inspect.js";
import {
  updateRunStepsFromResultStep,
  updateRunWarningMessages,
} from "../../infra/update-run-step.js";
import type { UpdateStepProgress, UpdateStepResult } from "../../infra/update-runner.js";
import { withTestDir } from "../../test-helpers/temp-dir.js";
import { mockProcessPlatform } from "../../test-utils/vitest-spies.js";
import * as utils from "../../utils.js";
import * as restartProbe from "../daemon-cli/restart-health-probe.js";
import { executeMutableUpdate } from "./update-command-execution.js";
import { gatewayServiceCommandUsesRoot } from "./update-command-service-plan.js";

const { executionParams, inspectOrStopService, mocks, schemaContext, successfulUpdate } =
  await import("./update-command-execution.test-support.js");

describe("mutable update validation", () => {
  it.each(
    (["package", "git"] as const).flatMap((kind) =>
      [undefined, 30_000].map((timeoutMs) => ({ kind, timeoutMs })),
    ),
  )(
    "preserves aggregate work intent at $kind activation ($timeoutMs)",
    async ({ kind, timeoutMs }) => {
      // Deadline propagation does not need a running Gateway; readiness has its own fixture below.
      mocks.serviceStopped = true;
      const budgets = await import("../../infra/update-finalization-budget.js");
      const budget = vi
        .spyOn(budgets, "resolveUpdateFinalizationTimeoutMs")
        .mockResolvedValue(180_000);
      mocks.runPackageUpdate.mockImplementation(async ({ beforeActivate }) => {
        await beforeActivate();
        return successfulUpdate;
      });
      mocks.runGitUpdate.mockImplementation(
        async (
          params: Parameters<typeof import("./update-command-git.js").updateGitInstall>[0],
        ) => {
          if (!params.inspectGitTarget || !params.beforeGitMutation) {
            throw new Error("Expected both real Git admission callbacks");
          }
          const target = { schemaVersions: { state: 15, agent: 19 } };
          await params.inspectGitTarget(target);
          await params.beforeGitMutation(target);
          return { ...successfulUpdate, mode: "git" };
        },
      );

      const execution = await executeMutableUpdate({
        ...executionParams(kind),
        timeoutMs,
        updateStepTimeoutMs: timeoutMs ?? 30 * 60_000,
      });

      expect(execution?.result.status).toBe("ok");
      expect(execution?.mutationStarted).toBe(true);
      expect(mocks.prepareMutableUpdate).toHaveBeenCalledTimes(kind === "package" ? 2 : 3);
      expect(mocks.prepareMutableUpdate.mock.calls.at(-1)?.[1]).toBe(
        timeoutMs === undefined ? undefined : 180_000,
      );
      expect(budget).toHaveBeenCalledTimes(timeoutMs === undefined ? 0 : 1);
    },
  );

  it.each(["package", "git"] as const)(
    "continues the %s update with the recorded readiness warning instead of inference repair",
    async (kind) => {
      const message =
        "Readiness probe http://127.0.0.1:18789/readyz failed: HTTP 502. Check the configured proxy.";
      const step: UpdateStepResult = {
        name: "candidate gateway canary",
        command: "gateway run",
        cwd: "/candidate",
        durationMs: 1,
        exitCode: null,
        advisory: { kind: "candidate-runtime-unavailable", message },
        failureFacts: [{ check: "readyz", code: "candidate-readiness-probe-failed", message }],
      };
      mocks.validateCanary.mockImplementation(async ({ onStep }) => {
        onStep(step);
        return {
          status: "ok",
          phase: "readiness",
          steps: [step],
          durationMs: 1,
          logTail: [message],
        };
      });
      const repair = await import("./update-command-repair.js");
      const runRepair = vi.spyOn(repair, "runUpdateCommandRepair");
      const accepted = vi.fn();
      const runStagedUpdate = async ({
        validateCandidate,
      }: {
        validateCandidate?: (root: string) => Promise<unknown>;
      }) => {
        expect(validateCandidate).toBeTypeOf("function");
        await validateCandidate?.("/candidate");
        accepted();
        return successfulUpdate;
      };
      mocks.runPackageUpdate.mockImplementation(runStagedUpdate);
      mocks.runGitUpdate.mockImplementation(runStagedUpdate);
      const onStepComplete = vi.fn<NonNullable<UpdateStepProgress["onStepComplete"]>>();

      const execution = await executeMutableUpdate({
        ...executionParams(kind),
        progress: { onStepComplete },
      });

      expect(execution?.result.status).toBe("ok");
      expect(accepted).toHaveBeenCalledOnce();
      expect(runRepair).not.toHaveBeenCalled();
      expect(onStepComplete).toHaveBeenCalledWith(expect.objectContaining(step));
      const recorded = onStepComplete.mock.calls.flatMap(([completed]) =>
        updateRunStepsFromResultStep(completed),
      );
      expect(updateRunWarningMessages(recorded)).toEqual([message]);
      expect(recorded.every((entry) => entry.status === "completed")).toBe(true);
    },
  );

  it.each(
    (["package", "git"] as const).flatMap((kind) =>
      [undefined, 30_000, 600_000].map((timeoutMs) => ({ kind, timeoutMs })),
    ),
  )(
    "passes only the operator's $timeoutMs ms deadline to $kind candidate validation",
    async ({ kind, timeoutMs }) => {
      const runStagedUpdate = async ({
        validateCandidate,
      }: {
        validateCandidate?: (root: string) => Promise<unknown>;
      }) => {
        expect(validateCandidate).toBeTypeOf("function");
        await validateCandidate?.("/candidate");
        return successfulUpdate;
      };
      mocks.runPackageUpdate.mockImplementation(runStagedUpdate);
      mocks.runGitUpdate.mockImplementation(runStagedUpdate);

      const execution = await executeMutableUpdate({
        ...executionParams(kind),
        timeoutMs,
        updateStepTimeoutMs: timeoutMs ?? 30 * 60_000,
      });

      expect(execution?.result.status).toBe("ok");
      expect(mocks.validateCanary).toHaveBeenCalledOnce();
      expect(mocks.validateCanary.mock.calls[0]?.[0].root).toBe("/candidate");
      expect(mocks.validateCanary.mock.calls[0]?.[0].timeoutMs).toBe(timeoutMs);
    },
  );

  it.each([
    ["measured startup", undefined, true, undefined],
    ["different service installation", undefined, true, undefined],
    ["explicit allowance", 450_000, true, undefined],
    ["explicit deadline", 30_000, false, undefined],
    ["terminal version mismatch", undefined, false, "version"],
    ["replaced executor", undefined, false, "executor"],
  ] as const)(
    "preserves previous Gateway verification through slow readiness (%s)",
    async (allowance, timeoutMs, verified, failure) =>
      withTestDir({ prefix: "previous-gateway-readiness-" }, async (root) => {
        const installationDrift = allowance === "different service installation";
        const cliRoot = installationDrift ? path.join(root, "cli-install") : root;
        if (installationDrift) {
          await fs.mkdir(cliRoot);
          await fs.writeFile(
            path.join(cliRoot, "package.json"),
            JSON.stringify({ name: "openclaw", version: "2.0.0" }),
          );
        }
        const readyAtMs = 400_000;
        mockProcessPlatform("linux");
        let elapsedMs = 0;
        const epochMs = Date.now();
        vi.spyOn(performance, "now").mockImplementation(() => elapsedMs);
        vi.spyOn(Date, "now").mockImplementation(() => epochMs + elapsedMs);
        vi.spyOn(utils, "sleep").mockImplementation(async (delayMs) => {
          elapsedMs += delayMs;
        });
        let readyObservedAtMs: number | undefined;
        let stoppedAtMs: number | undefined;
        let replaceExecutor: (() => void) | undefined;
        const server = createServer((request, response) => {
          const ready = elapsedMs >= readyAtMs;
          if (request.url === "/readyz" && ready) {
            readyObservedAtMs = elapsedMs;
            replaceExecutor?.();
          }
          response.writeHead(request.url === "/readyz" && !ready ? 503 : 200).end();
        });
        server.listen(0, "127.0.0.1");
        await once(server, "listening");
        const address = server.address();
        if (!address || typeof address === "string") {
          throw new Error("Missing synthetic Gateway listener");
        }
        try {
          await fs.mkdir(path.join(root, "dist"));
          await fs.writeFile(
            path.join(root, "package.json"),
            JSON.stringify({ name: "openclaw", version: "1.0.0" }),
          );
          await fs.writeFile(path.join(root, "dist", "index.js"), "");
          const context = schemaContext("default");
          const config = { gateway: { mode: "local" as const, port: address.port } };
          const configSnapshot = {
            ...context.configSnapshot,
            config,
            sourceConfig: config,
          };
          const managedEnv = { HOME: root, OPENCLAW_STATE_DIR: path.join(root, ".openclaw") };
          vi.spyOn(os, "userInfo").mockReturnValue({
            uid: 1000,
            gid: 1000,
            username: "operator",
            homedir: root,
            shell: "/bin/sh",
          });
          mocks.captureManagedContext.mockResolvedValue({
            env: managedEnv,
            configSnapshot,
            pluginInstallRecords: {},
          });
          vi.spyOn(configFile, "readConfigFileSnapshot").mockResolvedValue(configSnapshot);
          vi.spyOn(restartProbe, "resolveGatewayRestartProbeContext").mockResolvedValue({
            config,
            auth: {},
          });
          const service = gatewayService.resolveGatewayService();
          vi.spyOn(gatewayService, "resolveGatewayService").mockReturnValue(service);
          vi.spyOn(service, "isAbsent").mockResolvedValue(false);
          vi.spyOn(service, "isLoaded").mockResolvedValue(true);
          vi.spyOn(service, "readRuntime").mockResolvedValue({
            status: "running",
            pid: 8000,
            systemd: { managerUid: 1000 },
          });
          vi.spyOn(service, "readCommand").mockResolvedValue({
            programArguments: [process.execPath, path.join(root, "dist", "index.js"), "gateway"],
          });
          expect(await gatewayServiceCommandUsesRoot({ root, env: managedEnv })).toBe(true);
          vi.spyOn(portInspection, "inspectPortUsage").mockImplementation(async (port) => ({
            port,
            status: "busy",
            listeners: [{ pid: 8000, commandLine: "openclaw-gateway" }],
            hints: [],
          }));
          vi.spyOn(gatewayCall, "callGateway").mockImplementation(
            gatewayHealthResponse({
              server: {
                version: failure === "version" ? "0.9.0" : "1.0.0",
                bootId: "previous-boot",
              },
            }),
          );
          mocks.validateCanary.mockResolvedValue({
            status: "ok",
            phase: "readiness",
            durationMs: 70_000,
            logTail: [],
            steps: [
              {
                name: "Checking Gateway startup",
                command: "gateway run",
                cwd: root,
                durationMs: 70_000,
                exitCode: 0,
              },
            ],
          });
          mocks.maybeStopService.mockImplementation(async ({ phase }) => {
            if (phase === "prepare") {
              stoppedAtMs = elapsedMs;
            }
            const stopped = inspectOrStopService(phase);
            return installationDrift
              ? {
                  ...stopped,
                  servicePort: address.port,
                  serviceUpdateVerdict: {
                    kind: "owned",
                    root,
                    fingerprint: "service-fingerprint",
                    refreshDefinition: true,
                    requiresInstallRootRefresh: true,
                  },
                }
              : stopped;
          });
          mocks.runPackageUpdate.mockImplementation(
            async (
              params: Parameters<
                typeof import("./update-command-package.js").runPackageInstallUpdate
              >[0],
            ) => {
              await params.validateCandidate(root);
              await params.beforeActivate();
              return successfulUpdate;
            },
          );
          const params = {
            ...executionParams("package"),
            root: cliRoot,
            timeoutMs,
            updateStepTimeoutMs: timeoutMs ?? 20 * 60_000,
          };
          if (failure === "executor") {
            replaceExecutor = () => {
              params.opts.run = { runId: "replacement-run", env: { OPENCLAW_STATE_DIR: root } };
            };
          }
          const execution = await executeMutableUpdate(params);
          if (failure === "executor") {
            expect(execution?.result.status).toBe("error");
            expect(execution?.failure?.detail).toContain("lost its original executor");
            expect(stoppedAtMs).toBeUndefined();
            expect(execution?.previousVerified).toBe(false);
            return;
          }
          expect(execution?.result.status, JSON.stringify(mocks.runtimeError.mock.calls)).toBe(
            "ok",
          );
          expect(
            execution?.previousVerified,
            JSON.stringify({ readyObservedAtMs, stoppedAtMs }),
          ).toBe(verified);
          if (installationDrift) {
            expect(execution?.preManagedServiceStop?.serviceIdentity).toEqual({ version: "1.0.0" });
          }
          if (verified) {
            expect(readyObservedAtMs).toBeGreaterThanOrEqual(readyAtMs);
            expect(stoppedAtMs).toBeGreaterThanOrEqual(readyObservedAtMs!);
          } else {
            expect(readyObservedAtMs).toBeUndefined();
            expect(stoppedAtMs).toBeLessThan(readyAtMs);
            if (failure === "version") {
              expect(stoppedAtMs).toBe(0);
            }
          }
        } finally {
          server.closeAllConnections();
          const closed = once(server, "close");
          server.close();
          await closed;
        }
      }),
  );
});
