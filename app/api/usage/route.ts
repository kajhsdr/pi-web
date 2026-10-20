import { NextResponse } from "next/server";
import { getUsageSnapshot } from "@/lib/usage-analytics";
import { usageDateFormatter } from "@/lib/usage-calendar";

export const dynamic = "force-dynamic";

// GET /api/usage?timeZone=Asia/Shanghai — 按浏览器的 IANA 时区划分日期。
// 未传 timeZone 时使用固定的 UTC 默认值，兼容现有 API 调用方。
export async function GET(request: Request) {
  const timeZone = new URL(request.url).searchParams.get("timeZone") ?? "UTC";
  try {
    usageDateFormatter(timeZone);
  } catch {
    return NextResponse.json({ error: "Invalid IANA time zone" }, { status: 400 });
  }
  try {
    return NextResponse.json(await getUsageSnapshot(undefined, timeZone));
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
