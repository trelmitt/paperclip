import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Command } from "commander";
import * as p from "@clack/prompts";
import pc from "picocolors";
import type { ServerConfig } from "../config/schema.js";
import { readConfig, resolveConfigPath } from "../config/store.js";
import { detectTailnetBindHost } from "../config/server-bind.js";
import { addAllowedHostname } from "./allowed-hostname.js";

const execFileAsync = promisify(execFile);
const TAILSCALE_TIMEOUT_MS = 5000;

interface ShareOptions {
  config?: string;
  dryRun?: boolean;
}

/**
 * The one hard invariant of `share`: it exposes Paperclip over `tailscale serve`
 * — tailnet-private HTTPS, reachable only by the operator's own logged-in
 * devices — and NEVER `tailscale funnel` (which publishes to the public
 * internet). The argv is built here so a test can assert "funnel" never appears.
 */
export function buildTailscaleServeArgs(port: number): string[] {
  return ["serve", "--bg", "--https=443", `http://127.0.0.1:${port}`];
}

/** The reverse of {@link buildTailscaleServeArgs} — how the operator stops sharing. */
export function buildTailscaleServeResetArgs(): string[] {
  return ["serve", "--https=443", "off"];
}

/**
 * Refuse to share a server that does not require authentication. A
 * `local_trusted` server trusts every caller, so placing it on the tailnet would
 * let any tailnet peer in unauthenticated — precisely what must not happen.
 */
export function assertShareableDeployment(server: Pick<ServerConfig, "deploymentMode">): void {
  if (server.deploymentMode !== "authenticated") {
    throw new Error(
      `Refusing to share: server.deploymentMode is "${server.deploymentMode}". ` +
        "paperclipai share only exposes an authenticated server, so tailnet peers must log in. " +
        "Re-run onboarding with an authenticated (tailnet) preset first.",
    );
  }
}

/** Extract the node's MagicDNS name from `tailscale status --json`. */
export function parseTailnetDnsName(statusJson: string): string | null {
  try {
    const parsed = JSON.parse(statusJson) as { Self?: { DNSName?: string } };
    const dns = parsed.Self?.DNSName?.trim();
    if (!dns) return null;
    return dns.replace(/\.$/, ""); // strip the trailing FQDN dot
  } catch {
    return null;
  }
}

export function buildShareUrl(hostname: string): string {
  return `https://${hostname}/`;
}

async function resolveTailnetHostname(): Promise<string> {
  try {
    const { stdout } = await execFileAsync("tailscale", ["status", "--json"], {
      encoding: "utf8",
      timeout: TAILSCALE_TIMEOUT_MS,
    });
    const dns = parseTailnetDnsName(stdout);
    if (dns) return dns;
  } catch {
    // fall through to the IP-based fallback
  }
  const ip = detectTailnetBindHost();
  if (ip) return ip;
  throw new Error(
    "Could not determine a tailnet address. Is Tailscale running and logged in? Check `tailscale status`.",
  );
}

async function renderQr(url: string): Promise<void> {
  try {
    const qrcode = (await import("qrcode-terminal")).default;
    qrcode.generate(url, { small: true }, (qr) => process.stdout.write(`${qr}\n`));
  } catch {
    // QR is a convenience; the printed URL is the source of truth.
  }
}

export function registerShareCommand(program: Command): void {
  program
    .command("share")
    .description(
      "Expose this Paperclip to your tailnet over authenticated HTTPS (tailscale serve) and print a QR to pair a phone. Never uses Funnel.",
    )
    .option("-c, --config <path>", "Path to config file")
    .option("--dry-run", "Print the serve command, URL, and QR without running tailscale serve", false)
    .action(async (opts: ShareOptions) => {
      try {
        await runShare(opts);
      } catch (err) {
        p.log.error(err instanceof Error ? err.message : String(err));
        process.exitCode = 1;
      }
    });
}

async function runShare(opts: ShareOptions): Promise<void> {
  const configPath = resolveConfigPath(opts.config);
  const config = readConfig(opts.config);
  if (!config) {
    throw new Error(`No config found at ${configPath}. Run \`paperclipai onboard\` first.`);
  }

  assertShareableDeployment(config.server);

  const hostname = await resolveTailnetHostname();
  const url = buildShareUrl(hostname);
  const serveArgs = buildTailscaleServeArgs(config.server.port);

  // Defensive floor: enforce the never-funnel invariant at the call site too,
  // not only in the builder, so a future edit to the builder cannot smuggle it in.
  if (serveArgs.includes("funnel")) {
    throw new Error("Internal error: paperclipai share must never invoke tailscale funnel.");
  }

  // Allow the tailnet hostname so the authenticated/private server accepts it.
  await addAllowedHostname(hostname, { config: opts.config });

  if (opts.dryRun) {
    p.log.info(`[dry-run] Would run: ${pc.cyan(`tailscale ${serveArgs.join(" ")}`)}`);
    p.log.info(`[dry-run] Share URL: ${pc.cyan(url)}`);
    await renderQr(url);
    return;
  }

  await execFileAsync("tailscale", serveArgs, { timeout: TAILSCALE_TIMEOUT_MS });

  p.log.success(`Serving Paperclip on your tailnet (authenticated): ${pc.cyan(url)}`);
  await renderQr(url);
  p.log.message(pc.dim(`Stop sharing with: tailscale ${buildTailscaleServeResetArgs().join(" ")}`));
  p.log.message(pc.dim("Restart the Paperclip server if the allowed-hostname was newly added."));
}
