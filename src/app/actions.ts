"use server";

import { revalidatePath } from "next/cache";
import { dbFor } from "@/db/tenant-db";
import { currentUser } from "@/lib/current-user";

export async function addNote(formData: FormData): Promise<void> {
  const text = String(formData.get("text") ?? "").trim();
  if (text) dbFor(await currentUser()).addNote(text);
  revalidatePath("/");
}

export async function deleteNote(formData: FormData): Promise<void> {
  dbFor(await currentUser()).deleteNote(Number(formData.get("id")));
  revalidatePath("/");
}
