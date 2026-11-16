import { NextResponse } from "next/server";
import { currentUser } from "@/lib/current-user";

export async function GET(): Promise<Response> {
  return NextResponse.json(await currentUser());
}
