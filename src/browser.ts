import { spawn as nodeSpawn } from "node:child_process";

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

export interface OpenBrowserDeps {
  platform?: NodeJS.Platform;
  spawn?: typeof nodeSpawn;
}

/**
 * Open `url` in the default browser, fire-and-forget. The URL is passed as a
 * single argument (never through a shell). Failures are ignored: OpenCode also
 * prints the URL, so the user can still open it by hand.
 *
 * Only the OpenCode v1 entry point uses this — v1 leaves opening the URL to the
 * plugin, whereas v2 opens it itself.
 */
export function openBrowser(url: string, deps: OpenBrowserDeps = {}): void {
  const platform = deps.platform ?? process.platform;
  const spawn = deps.spawn ?? nodeSpawn;
  const [command, args] =
    platform === "darwin"
      ? ["open", [url]]
      : platform === "win32"
        ? ["rundll32", ["url.dll,FileProtocolHandler", url]]
        : ["xdg-open", [url]];
  try {
    const child = spawn(command, args, { stdio: "ignore", detached: true });
    child.on("error", () => {});
    child.unref();
  } catch {
    // No opener available (minimal container…): the printed URL is the fallback.
  }
}
