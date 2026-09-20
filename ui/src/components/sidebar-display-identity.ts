import { gatewayPresentationScope } from "../app/gateway-presentation-scope.ts";
import type { ApplicationGateway } from "../app/gateway.ts";
import type { AuthenticatedUser } from "../app/user-profile.ts";

const identities = new WeakMap<ReturnType<typeof gatewayPresentationScope>, AuthenticatedUser>();

/** Display-only identity survives transport recovery, never a change of account or credentials. */
export function resolveSidebarDisplayIdentity(
  gateway?: ApplicationGateway,
): AuthenticatedUser | null {
  if (!gateway) {
    return null;
  }
  const scope = gatewayPresentationScope(gateway);
  if (gateway.snapshot.phase === "connected") {
    const user = gateway.snapshot.selfUser ?? null;
    if (user) {
      identities.set(scope, user);
    } else {
      identities.delete(scope);
    }
    return user;
  }
  if (gateway.snapshot.phase === "reconnecting" || gateway.snapshot.phase === "reload-required") {
    return identities.get(scope) ?? null;
  }
  identities.delete(scope);
  return null;
}
