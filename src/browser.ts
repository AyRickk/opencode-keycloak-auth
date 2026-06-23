/**
 * Best-effort detection of whether an interactive browser is reachable on this
 * machine. Used to order the login methods so the device flow is offered first
 * in headless / SSH / container environments.
 */

type Env = Record<string, string | undefined>;

/**
 * Returns true when we believe a local browser can be opened and can reach a
 * localhost callback server. Conservative: when unsure on Linux we assume no
 * browser (device flow is always a safe fallback).
 */
export function hasLocalBrowser(
  env: Env = process.env,
  platform: NodeJS.Platform = process.platform,
): boolean {
  // Remote shells almost never have a usable local browser / localhost callback.
  if (env["SSH_CONNECTION"] || env["SSH_TTY"] || env["SSH_CLIENT"]) return false;
  // Common container / CI signals.
  if (env["KUBERNETES_SERVICE_HOST"] || env["CI"] || env["CONTAINER"]) return false;

  // macOS and Windows can open a browser out of the box.
  if (platform === "darwin" || platform === "win32") return true;

  // On Linux/other Unix we need a graphical session.
  return Boolean(env["DISPLAY"] || env["WAYLAND_DISPLAY"]);
}
