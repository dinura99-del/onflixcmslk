import { describe, it, expect } from "vitest";
import { parseSrt, buildSrt, decodeEntities, myMemoryEmail } from "@/lib/engine.server";

describe("MyMemory helpers", () => {
  it("decodes entities", () => {
    expect(decodeEntities("&quot;a&quot; &#39;b&#39; &amp; &lt;i&gt;")).toBe(`"a" 'b' & <i>`);
  });
  it("keeps indices and timestamps unchanged on round trip", () => {
    const srt = "1\n00:00:01,000 --> 00:00:02,000\nHello\n\n2\n00:00:03,000 --> 00:00:04,000\nHi\nthere\n";
    const cues = parseSrt(srt);
    expect(cues[1]).toEqual({ index: "2", time: "00:00:03,000 --> 00:00:04,000", text: "Hi\nthere" });
    expect(buildSrt(cues)).toBe(srt);
  });
  it("defaults email", () => {
    delete process.env["MYMEMORY_USER_EMAIL"];
    expect(myMemoryEmail({})).toBe("cinemaestlk@gmail.com");
  });
});
