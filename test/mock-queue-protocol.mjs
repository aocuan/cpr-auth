#!/usr/bin/env node

import fs from "node:fs/promises";

const emailIndex = process.argv.indexOf("--email");
const email = emailIndex >= 0 ? process.argv[emailIndex + 1] : "unknown@example.invalid";
if (process.env.MOCK_QUEUE_LAUNCH_LOG) await fs.appendFile(process.env.MOCK_QUEUE_LAUNCH_LOG, `${email}\n`);
console.log(`[1/5] Mock queued login started for ${email}`);
console.log("Email OTP (r=resend, q=quit):");

await new Promise((resolve) => {
  const timer = setTimeout(resolve, 60_000);
  process.once("SIGTERM", () => {
    clearTimeout(timer);
    resolve();
  });
});
