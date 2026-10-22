// A streamed NDJSON response whose producer keeps running if the browser disconnects.
export function ndjsonStream(waitUntil, producer) {
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();
  let gone = false;
  const send = async (obj) => {
    if (gone) return;
    try { await writer.write(encoder.encode(JSON.stringify(obj) + "\n")); } catch { gone = true; }
  };
  const run = (async () => {
    try { await producer(send); }
    catch (e) { console.error(e); await send({ t: "error", message: "Something went wrong. Please try again." }); }
    try { await writer.close(); } catch {}
  })();
  waitUntil(run);
  return new Response(readable, {
    headers: { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" },
  });
}
