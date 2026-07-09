const YANDEX_DOWNLOAD_API = "https://cloud-api.yandex.net/v1/disk/public/resources/download";

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Range, Content-Type");
  res.setHeader("Access-Control-Expose-Headers", "Accept-Ranges, Content-Length, Content-Range, Content-Type");
}

function isAllowedPublicUrl(value) {
  try {
    const url = new URL(value);
    return ["yadi.sk", "disk.yandex.ru"].includes(url.hostname);
  } catch {
    return false;
  }
}

async function resolvePublicHref(publicUrl) {
  const apiUrl = `${YANDEX_DOWNLOAD_API}?public_key=${encodeURIComponent(publicUrl)}`;
  const response = await fetch(apiUrl, {
    headers: {
      "Accept": "application/json",
    },
  });

  if (!response.ok) {
    throw new Error(`Yandex API returned ${response.status}`);
  }

  const payload = await response.json();
  if (!payload.href) {
    throw new Error("Yandex API returned no href");
  }
  return payload.href;
}

async function pipeWebStreamToNode(webStream, res, req) {
  const reader = webStream.getReader();
  let closed = false;
  req.on("close", () => {
    closed = true;
    reader.cancel().catch(() => {});
  });

  while (!closed) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!res.write(Buffer.from(value))) {
      await new Promise((resolve) => res.once("drain", resolve));
    }
  }
  if (!closed) res.end();
}

export default async function handler(req, res) {
  setCors(res);

  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }

  if (req.method !== "GET" && req.method !== "HEAD") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const publicUrl = Array.isArray(req.query.url) ? req.query.url[0] : req.query.url;
  if (!publicUrl || !isAllowedPublicUrl(publicUrl)) {
    res.status(400).json({ error: "Expected Yandex Disk public url" });
    return;
  }

  try {
    const href = await resolvePublicHref(publicUrl);
    const headers = {
      "Accept": "*/*",
      "Accept-Encoding": "identity",
      "User-Agent": "Mozilla/5.0",
    };
    if (req.headers.range) headers.Range = req.headers.range;

    const upstream = await fetch(href, {
      method: req.method === "HEAD" ? "HEAD" : "GET",
      headers,
      redirect: "follow",
    });

    res.status(upstream.status);
    for (const [source, target] of [
      ["accept-ranges", "Accept-Ranges"],
      ["content-length", "Content-Length"],
      ["content-range", "Content-Range"],
      ["content-type", "Content-Type"],
      ["etag", "ETag"],
      ["last-modified", "Last-Modified"],
    ]) {
      const value = upstream.headers.get(source);
      if (value) res.setHeader(target, value);
    }
    res.setHeader("Content-Disposition", "inline");
    res.setHeader("Cache-Control", upstream.ok ? "public, max-age=300" : "no-store");

    if (req.method === "HEAD" || !upstream.body) {
      res.end();
      return;
    }

    await pipeWebStreamToNode(upstream.body, res, req);
  } catch (error) {
    res.status(502).json({ error: "Video proxy failed", message: error.message });
  }
}
