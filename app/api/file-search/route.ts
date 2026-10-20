import { NextRequest, NextResponse } from "next/server";
import { getFileListing } from "@/lib/file-listing";
import { searchFileContents } from "@/lib/file-content-search";
import { resolveProjectDirectory } from "@/lib/project-directory";
import { getAllowedFileRoots } from "@/lib/file-access";

const MAX_QUERY_LENGTH = 200;

// GET /api/file-search?cwd=/abs/path&q=text
// { matches: { path, line, text }[], truncated } — literal, case-insensitive
// search through the project's own files (`.gitignore` respected). Guarded by
// the same allow-list as /api/files.
export async function GET(request: NextRequest) {
  try {
    const resolved = await resolveProjectDirectory(request.nextUrl.searchParams.get("cwd"));
    if ("response" in resolved) return resolved.response;
    const { directory } = resolved;

    const query = request.nextUrl.searchParams.get("q")?.trim().slice(0, MAX_QUERY_LENGTH) ?? "";
    if (!query) return NextResponse.json({ matches: [], truncated: false });

    const { files, hardTruncated } = await getFileListing(directory);
    const result = searchFileContents(directory, files, query, {
      signal: request.signal,
      allowedRoots: await getAllowedFileRoots(),
    });

    return NextResponse.json({
      matches: result.matches,
      truncated: result.truncated || hardTruncated,
    });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
