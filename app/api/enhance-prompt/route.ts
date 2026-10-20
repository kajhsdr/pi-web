import { NextResponse } from "next/server";
import { getModelRuntimeWithExtensions } from "@/lib/model-runtime";
import { enhancePrompt } from "@/lib/prompt-enhance";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";

export const dynamic = "force-dynamic";

// The composer's "improve prompt" button (#1312). Stateless on purpose: any
// chat, including a fresh one with no wrapper yet, can call it.

const MAX_NOTE_CHARS = 20_000;

export async function POST(req: Request) {
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
  const { text, provider, modelId } = (body ?? {}) as {
    text?: unknown;
    provider?: unknown;
    modelId?: unknown;
  };
  if (typeof text !== "string" || !text.trim()) {
    return NextResponse.json({ error: "text is required" }, { status: 400 });
  }
  if (typeof provider !== "string" || typeof modelId !== "string") {
    return NextResponse.json({ error: "provider and modelId are required" }, { status: 400 });
  }
  if (text.length > MAX_NOTE_CHARS) {
    return NextResponse.json({ error: `text is longer than ${MAX_NOTE_CHARS} characters` }, { status: 413 });
  }

  try {
    const runtime = await getModelRuntimeWithExtensions();
    const model = runtime.getModel(provider, modelId);
    if (!model) {
      return NextResponse.json({ error: `Model not found: ${provider}/${modelId}` }, { status: 404 });
    }
    const enhanced = await enhancePrompt(runtime, model, text, req.signal);
    return NextResponse.json({ text: enhanced });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
