import { html, nothing } from "lit";
import { t } from "../i18n/index.ts";
import { redactLoginFailureError } from "../lib/connection-hints.ts";
import type { GatewayStatus } from "../lib/gateway-status.ts";
import { icons } from "./icons.ts";

export function gatewayStatusLabel(kind: GatewayStatus): string {
  return t(`connection.${kind}`);
}

export function canRetryGatewayStatus(kind: GatewayStatus | null): boolean {
  return kind === "reconnecting" || kind === "offline";
}

export function renderGatewayStatus(props: {
  kind: GatewayStatus | null;
  queuedOutboxCount?: number;
  lastError?: string | null;
  onRetry?: () => void;
  announce?: boolean;
}) {
  const { kind } = props;
  const count = props.queuedOutboxCount ?? 0;
  if (!kind && !count) {
    return nothing;
  }
  const label = kind ? gatewayStatusLabel(kind) : null;
  const outbox = count ? t("connection.outboxCount", { count: String(count) }) : null;
  const content = html`
    ${
      kind
        ? html`<span class="gateway-status__state">
            <span class="gateway-status__icon" aria-hidden="true"
              >${
                kind === "suspending" || kind === "suspended"
                  ? icons.pause
                  : kind === "offline"
                    ? icons.alertTriangle
                    : icons.refresh
              }</span
            ><span class="gateway-status__label">${label}</span>
          </span>`
        : nothing
    }
    ${outbox ? html`<span class="gateway-status__outbox">${outbox}</span>` : nothing}
  `;
  const className = `gateway-status${kind ? ` gateway-status--${kind}` : ""}`;
  const retry = props.onRetry && canRetryGatewayStatus(kind);
  const status = retry
    ? html`<button
        type="button"
        class=${className}
        aria-label=${[label, outbox, t("connection.retryNow")].filter(Boolean).join(" — ")}
        @click=${props.onRetry}
      >
        ${content}
      </button>`
    : html`<span class=${className}>${content}</span>`;
  return html`<openclaw-tooltip
    class="gateway-status-tooltip"
    .content=${
      props.lastError && canRetryGatewayStatus(kind)
        ? redactLoginFailureError(props.lastError)
        : kind
          ? t(`connection.statusDetail.${kind}`)
          : t("connection.statusDetail.outbox")
    }
    ><span
      role=${props.announce === false ? nothing : "status"}
      aria-live=${props.announce === false ? nothing : "polite"}
      >${status}</span
    ></openclaw-tooltip
  >`;
}
