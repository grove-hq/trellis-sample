import { randomBytes } from "node:crypto";
import type { NextConfig } from "next";

// With no secret configured, sessions are signed with one that lasts until the server stops.
process.env.SESSION_SECRET ??= randomBytes(32).toString("hex");

const nextConfig: NextConfig = {
  // Next.js would otherwise write its own instructions into AGENTS.md whenever
  // a coding agent runs `next dev`. That file is this repo's to write.
  agentRules: false,
};

export default nextConfig;
