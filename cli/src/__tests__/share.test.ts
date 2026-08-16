import { describe, expect, it } from "vitest";
import {
  assertShareableDeployment,
  buildShareUrl,
  buildTailscaleServeArgs,
  buildTailscaleServeResetArgs,
  parseTailnetDnsName,
} from "../commands/share.js";

describe("paperclipai share", () => {
  it("serves over tailnet HTTPS and NEVER uses funnel", () => {
    const args = buildTailscaleServeArgs(3100);
    expect(args[0]).toBe("serve");
    expect(args).toContain("--https=443");
    expect(args).toContain("http://127.0.0.1:3100");
    // The core invariant: no path through the wrapper may ever reach funnel.
    expect(args).not.toContain("funnel");
    expect(args.join(" ")).not.toMatch(/funnel/);
  });

  it("stop command also never uses funnel", () => {
    const reset = buildTailscaleServeResetArgs();
    expect(reset[0]).toBe("serve");
    expect(reset).toContain("off");
    expect(reset).not.toContain("funnel");
  });

  it("refuses to share a server that does not require authentication", () => {
    expect(() => assertShareableDeployment({ deploymentMode: "local_trusted" })).toThrow(
      /only exposes an authenticated server/,
    );
  });

  it("allows sharing an authenticated server", () => {
    expect(() => assertShareableDeployment({ deploymentMode: "authenticated" })).not.toThrow();
  });

  it("parses the MagicDNS name and strips the trailing dot", () => {
    const json = JSON.stringify({ Self: { DNSName: "my-mac.tail1a2b.ts.net." } });
    expect(parseTailnetDnsName(json)).toBe("my-mac.tail1a2b.ts.net");
  });

  it("returns null when the tailscale status JSON has no DNS name", () => {
    expect(parseTailnetDnsName("{}")).toBeNull();
    expect(parseTailnetDnsName("not json")).toBeNull();
  });

  it("builds an https share URL", () => {
    expect(buildShareUrl("my-mac.tail1a2b.ts.net")).toBe("https://my-mac.tail1a2b.ts.net/");
  });
});
