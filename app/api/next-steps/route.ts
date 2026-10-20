import { NextResponse } from "next/server";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import { readNextStepsSettings, updateNextStepsSettings } from "@/lib/next-steps-settings";

export const dynamic = "force-dynamic";

// Settings › General's next-step suggestions (#1341): whether a settled run
// asks a model for 1–3 follow-up messages, and which model asks. Only this
// file is touched; the generation itself happens in the session wrapper.

export async function GET() {
  try {
    return NextResponse.json(await readNextStepsSettings());
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}

export async function PUT(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  if (!hasJsonContentType(req)) {
    return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const patch = (body ?? {}) as { enabled?: unknown; model?: unknown };
  if (patch.enabled !== undefined && typeof patch.enabled !== "boolean") {
    return NextResponse.json({ error: "enabled must be a boolean" }, { status: 400 });
  }
  if (patch.model !== undefined && typeof patch.model !== "string") {
    return NextResponse.json({ error: "model must be a string" }, { status: 400 });
  }
  try {
    const next = await updateNextStepsSettings({
      enabled: typeof patch.enabled === "boolean" ? patch.enabled : undefined,
      model: typeof patch.model === "string" ? patch.model : undefined,
    });
    return NextResponse.json(next);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
