// Where the Action Elite server is. The built page, action-elite.html, carries
//   <meta name="ae-server" content="https://seu-servidor.onrender.com">
// edited in the file itself (no rebuild). Empty = the page's own host on port 8090 (local development).
export function serverUrl(): string {
  if (typeof document !== "undefined") {
    const c = document.querySelector('meta[name="ae-server"]')?.getAttribute("content")?.trim() ?? "";
    if (c) {
      const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(c) ? c : `https://${c}`;
      return withScheme.replace(/\/+$/, "").replace(/^http/i, "ws");
    }
  }
  const secure = typeof location !== "undefined" && location.protocol === "https:";
  const host = typeof location !== "undefined" && location.hostname ? location.hostname : "localhost";
  return `${secure ? "wss" : "ws"}://${host}:8090`;
}
