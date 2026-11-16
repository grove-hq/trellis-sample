import { NextResponse } from "next/server";
import { dbFor } from "@/db/tenant-db";
import { currentUser } from "@/lib/current-user";

export async function GET(): Promise<Response> {
  return NextResponse.json(dbFor(await currentUser()).notes());
}
