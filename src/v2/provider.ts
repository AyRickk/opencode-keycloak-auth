/**
 * Bind the OpenAI-compatible provider to the Keycloak integration (OpenCode v2).
 *
 * How the host behaves (verified against OpenCode 2.0.25):
 *  - When resolving a model it reads the active connection of
 *    `provider.integrationID ?? providerID` and passes the OAuth access token to
 *    `@opencode/ai/providers/openai-compatible` as its API key, i.e. it sends
 *    `Authorization: Bearer <access>` itself. No request hook is needed, and a
 *    provider whose id equals the integration id is bound implicitly.
 *  - Providers declared in opencode.json are NOT visible to plugin transforms;
 *    the host overlays them afterwards. So adding a provider with the same id is
 *    non-destructive: the user's name, settings, headers and models win, our
 *    `integrationID` is kept.
 */
import type { ProviderEditor } from "@opencode/plugin/promise/provider";
import type { KeycloakConfig } from "../config.js";
import { log } from "../log.js";

export type { ProviderEditor };

type Info = Parameters<ProviderEditor["add"]>[0]["info"];

const OPENAI_COMPATIBLE = "@opencode/ai/providers/openai-compatible";

export function linkProvider(editor: ProviderEditor, config: KeycloakConfig): void {
  const id = config.providerId;
  const integrationID = id as NonNullable<Info["integrationID"]>;

  if (editor.get(id)) {
    // Known provider (e.g. from models.dev or another plugin): bind, change nothing else.
    editor.update(id, (provider) => {
      provider.integrationID = integrationID;
    });
    log.debug(`bound existing provider ${id} to the keycloak integration`);
    return;
  }

  if (!config.baseUrl) {
    log.debug(`no baseUrl configured; provider ${id} must be declared in opencode.json (providers.${id})`);
    return;
  }

  const info: Info = {
    id: id as Info["id"],
    name: "Keycloak",
    activation: "auto",
    package: OPENAI_COMPATIBLE,
    integrationID,
    settings: { baseURL: config.baseUrl },
  };
  editor.add({ info, models: [] });
  log.debug(`added provider ${id} (${OPENAI_COMPATIBLE}, baseURL=${config.baseUrl})`);
}
