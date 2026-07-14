import type { RequestHandler } from "express";

const DEMO_COOKIE = "spotsync_demo_session_id";

export function attachDemoHeaders(): RequestHandler {
  return (req, _res, next) => {
    const cookieHeader = req.headers.cookie ?? "";
    const match = cookieHeader.match(
      new RegExp(`(?:^|;\\s*)${DEMO_COOKIE}=([^;]+)`),
    );
    const fromCookie = match?.[1] ? decodeURIComponent(match[1]) : "";
    const fromHeader = String(req.headers["x-demo-session-id"] ?? "").trim();
    const sessionId = fromHeader || fromCookie;
    if (sessionId) {
      req.headers["x-demo-session-id"] = sessionId;
      if (!req.headers["x-demo-mode"]) {
        req.headers["x-demo-mode"] = "true";
      }
    }
    next();
  };
}

export { DEMO_COOKIE };
