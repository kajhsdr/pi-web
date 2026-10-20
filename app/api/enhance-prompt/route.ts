import { NextResponse } from "next/server";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { getModelRuntimeWithExtensions } from "@/lib/model-runtime";
import { enhancePrompt } from "@/lib/prompt-enhance";
import { parseModelKey } from "@/lib/next-steps";
import { readNextStepsSettings } from "@/lib/next-steps-settings";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import { getRpcSession, startRpcSession } from "@/lib/rpc-manager";
import { resolveSessionPath } from "@/lib/session-reader";

export const dynamic = "force-dynamic";

// 优先使用会话已加载的 provider，未传会话时兼容共享 runtime。
const MAX_NOTE_CHARS = 20_000;
const SESSION_ID_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;

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
  const { text, provider, modelId, sessionId } = (body ?? {}) as {
    text?: unknown;
    provider?: unknown;
    modelId?: unknown;
    sessionId?: unknown;
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

  if (sessionId !== undefined && (typeof sessionId !== "string" || !SESSION_ID_PATTERN.test(sessionId))) {
    return NextResponse.json({ error: "Invalid sessionId" }, { status: 400 });
  }

  try {
    req.signal.throwIfAborted();
    // 两项功能共享模型偏好；下一步建议开关不控制提示词优化。
    const settings = await readNextStepsSettings();
    req.signal.throwIfAborted();
    const preferred = parseModelKey(settings.model);
    // 手工写入的非法偏好也明确报错，不能悄悄改用会话模型。
    if (settings.model && !preferred) {
      return NextResponse.json({ error: `Model not found: ${settings.model}` }, { status: 404 });
    }
    const selectedProvider = preferred?.provider ?? provider;
    const selectedModelId = preferred?.modelId ?? modelId;
    let runtime: ModelRuntime;
    if (sessionId !== undefined) {
      let wrapper = getRpcSession(sessionId);
      if (!wrapper?.isAlive()) {
        const sessionFile = await resolveSessionPath(sessionId);
        if (!sessionFile) {
          return NextResponse.json({ error: "Session not found" }, { status: 404 });
        }
        req.signal.throwIfAborted();
        wrapper = (await startRpcSession(sessionId, sessionFile, undefined)).session;
      }
      // session_start 可延迟注册 provider，必须等扩展绑定完成。
      await wrapper.waitUntilReady();
      runtime = wrapper.inner.modelRuntime as ModelRuntime;
    } else {
      runtime = await getModelRuntimeWithExtensions();
    }
    req.signal.throwIfAborted();
    let model = runtime.getModel(selectedProvider, selectedModelId);
    if (!model && preferred && sessionId !== undefined) {
      // 显式偏好可跨项目使用共享模型，但只能查找同一个指定模型。
      runtime = await getModelRuntimeWithExtensions();
      req.signal.throwIfAborted();
      model = runtime.getModel(selectedProvider, selectedModelId);
    }
    if (!model) {
      return NextResponse.json({ error: `Model not found: ${selectedProvider}/${selectedModelId}` }, { status: 404 });
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
