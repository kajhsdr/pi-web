import { NextResponse } from "next/server";
import { getUsageSnapshot } from "@/lib/usage-analytics";

export const dynamic = "force-dynamic";

// GET /api/usage — 跨会话的花费与 token 汇总。
// 首次要读几百个 session 文件，之后按文件指纹增量，30 秒内复用同一份结果。
export async function GET() {
  try {
    return NextResponse.json(await getUsageSnapshot());
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
