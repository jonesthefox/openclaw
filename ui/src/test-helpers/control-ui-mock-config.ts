// Serialized with the mock Gateway. Keep page state here and pass runtime dependencies explicitly.
export function createControlUiMockConfig(
  initialResponse: unknown,
  selectResponse: (method: string, params: unknown) => { found: boolean; value?: unknown },
  parseJson5: (raw: string) => unknown,
  isRecord: (value: unknown) => value is Record<string, unknown>,
) {
  // Stateful config store: config.set/config.apply persist the submitted raw
  // and advance the hash so autosave -> reload flows round-trip edits the way
  // the real gateway does. Active only when the scenario ships a config.get
  // fixture with a raw string; persisted in sessionStorage like groupsState.
  const configStateKey = "openclaw.control-ui-e2e.configState";
  const baseConfigResponse: Record<string, unknown> | null = (() => {
    const configured = initialResponse;
    return isRecord(configured) && typeof configured.raw === "string" ? configured : null;
  })();
  const initialConfigHash =
    typeof baseConfigResponse?.hash === "string" ? baseConfigResponse.hash : "mock-config-hash-0";
  const initialAppliedConfigHash =
    typeof baseConfigResponse?.appliedConfigHash === "string"
      ? baseConfigResponse.appliedConfigHash
      : initialConfigHash;
  let lastConfiguredConfigHash = initialConfigHash;
  let configState: {
    raw: string;
    revision: number;
    hash: string;
    appliedHash: string;
  } | null = baseConfigResponse
    ? {
        raw: baseConfigResponse.raw as string,
        revision: 0,
        hash: initialConfigHash,
        appliedHash: initialAppliedConfigHash,
      }
    : null;
  try {
    const rawConfigState = configState ? window.sessionStorage.getItem(configStateKey) : null;
    if (rawConfigState) {
      const stored = JSON.parse(rawConfigState) as unknown;
      if (
        isRecord(stored) &&
        typeof stored.raw === "string" &&
        typeof stored.revision === "number"
      ) {
        configState = {
          raw: stored.raw,
          revision: stored.revision,
          hash: typeof stored.hash === "string" ? stored.hash : initialConfigHash,
          appliedHash:
            typeof stored.appliedHash === "string" ? stored.appliedHash : initialAppliedConfigHash,
        };
      }
    }
  } catch {
    // Storage-disabled browser contexts still get the scenario fixture.
  }

  function persistConfigState(): void {
    try {
      window.sessionStorage.setItem(configStateKey, JSON.stringify(configState));
    } catch {
      // In-memory config still serves the current page.
    }
  }

  function adoptConfiguredConfig(configured: Record<string, unknown>): void {
    if (
      !configState ||
      typeof configured.raw !== "string" ||
      typeof configured.hash !== "string" ||
      configured.hash === lastConfiguredConfigHash
    ) {
      return;
    }
    lastConfiguredConfigHash = configured.hash;
    configState = {
      raw: configured.raw,
      revision: configState.revision,
      hash: configured.hash,
      appliedHash:
        typeof configured.appliedConfigHash === "string"
          ? configured.appliedConfigHash
          : configured.hash,
    };
    persistConfigState();
  }

  function mockConfigHash(): string {
    return configState?.hash ?? initialConfigHash;
  }

  function mockAppliedConfigHash(): string {
    return configState?.appliedHash ?? initialAppliedConfigHash;
  }

  function parseMockConfig(raw: string, fallback: unknown): { value: unknown; parsed: boolean } {
    try {
      return { value: parseJson5(raw), parsed: true };
    } catch {
      // Invalid raw keeps the caller's last valid fixture object.
      return { value: fallback, parsed: false };
    }
  }

  function response(method: string, params: unknown): unknown {
    if (configState && baseConfigResponse) {
      if (method === "config.get") {
        const configured = selectResponse(method, params);
        const configuredConfig = isRecord(configured.value) ? configured.value : baseConfigResponse;
        adoptConfiguredConfig(configuredConfig);
        const parsedConfig = parseMockConfig(configState.raw, configuredConfig.config);
        const parsedSource =
          parsedConfig.parsed &&
          typeof configuredConfig.raw === "string" &&
          configState.raw !== configuredConfig.raw &&
          isRecord(parsedConfig.value)
            ? parsedConfig.value
            : undefined;
        return {
          ...configuredConfig,
          ...(parsedSource && isRecord(configuredConfig.sourceConfig)
            ? { sourceConfig: parsedSource }
            : {}),
          ...(parsedSource && isRecord(configuredConfig.resolved)
            ? { resolved: parsedSource }
            : {}),
          config: parsedConfig.value,
          hash: mockConfigHash(),
          configRevisionHash: mockConfigHash(),
          appliedConfigHash: mockAppliedConfigHash(),
          raw: configState.raw,
        };
      }
      if (method === "config.set" || method === "config.apply") {
        // Enforce the production CAS contract: stale base hashes are rejected
        // (same code/message as the gateway) so conflict recovery is testable.
        const baseHash = isRecord(params) ? params.baseHash : undefined;
        if (baseHash !== mockConfigHash()) {
          return {
            __mockError: {
              code: "INVALID_REQUEST",
              message: "config changed since last load; re-run config.get and retry",
            },
          };
        }
        const raw = isRecord(params) && typeof params.raw === "string" ? params.raw : null;
        if (raw !== null) {
          const revision = configState.revision + 1;
          const hash = `mock-config-hash-${revision}`;
          configState = {
            raw,
            revision,
            hash,
            appliedHash:
              method === "config.apply"
                ? hash
                : (configState.appliedHash ?? initialAppliedConfigHash),
          };
          persistConfigState();
        }
        const configured = selectResponse(method, params);
        const configuredAck = isRecord(configured.value) ? configured.value : {};
        // Like the real gateway, return the persisted config and its new hash.
        return {
          ...configuredAck,
          ok: true,
          path: baseConfigResponse.path,
          hash: mockConfigHash(),
          config: parseMockConfig(configState.raw, baseConfigResponse.config).value,
        };
      }
    }
    return undefined;
  }

  return { adoptConfigured: adoptConfiguredConfig, response };
}
