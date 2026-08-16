import type { Command } from "commander";
import webpush from "web-push";
import pc from "picocolors";

// Web-push (phone notification) operator utilities. The keypair this prints is a
// deploy-time secret: the PRIVATE key goes into the server's env and must never
// be committed. The server reads PAPERCLIP_VAPID_PUBLIC_KEY / _PRIVATE_KEY.
export function registerPushCommands(program: Command): void {
  const push = program.command("push").description("Web push (phone notification) utilities");

  push
    .command("generate-vapid-keys")
    .description("Generate a VAPID keypair for web push. Inject the PRIVATE key into server env; never commit it.")
    .option("--json", "Output the keypair as JSON")
    .action((opts: { json?: boolean }) => {
      const keys = webpush.generateVAPIDKeys();
      if (opts.json) {
        console.log(JSON.stringify(keys, null, 2));
        return;
      }
      console.log(pc.bold("VAPID keypair generated.\n"));
      console.log(`${pc.dim("Public key: ")}${keys.publicKey}`);
      console.log(`${pc.dim("Private key:")}${pc.red(" (secret — do not commit)")} ${keys.privateKey}\n`);
      console.log(pc.dim("Add to the server environment, then restart:"));
      console.log(`export PAPERCLIP_VAPID_PUBLIC_KEY='${keys.publicKey}'`);
      console.log(`export PAPERCLIP_VAPID_PRIVATE_KEY='${keys.privateKey}'`);
      console.log(`export PAPERCLIP_VAPID_SUBJECT='mailto:you@example.com'`);
    });
}
