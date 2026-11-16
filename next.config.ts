import { randomBytes } from "node:crypto";
import type { NextConfig } from "next";

// With no secret configured, sessions are signed with one that lasts until the server stops.
process.env.SESSION_SECRET ??= randomBytes(32).toString("hex");

const nextConfig: NextConfig = {};

export default nextConfig;
