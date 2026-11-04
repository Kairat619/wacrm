import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { AuthRetryableFetchError } from "@supabase/supabase-js";
import { NextRequest } from "next/server";
import { __resetSessionChecksForTests } from "@/lib/auth/session-single-flight";

// --- Scenario knobs the mock reads -----------------------------------------
// `mockUser`         — what getUser() resolves to (a refreshed session ⇒ user,
//                      or null for the logged-out path).
// `refreshedCookies` — cookies Supabase writes via setAll() during getUser(),
//                      i.e. the freshly *rotated* auth token. The whole point
//                      of the test is that these must survive onto whatever
//                      response the middleware returns — including redirects.
let mockUser: { id: string } | null = null;
let mockAuthError: Error | null = null;
let getUserCalls = 0;
let refreshedCookies: Array<{
  name: string;
  value: string;
  options: Record<string, unknown>;
}> = [];

vi.mock("@supabase/ssr", () => ({
  createServerClient: (
    _url: string,
    _key: string,
    opts: {
      cookies: { setAll: (c: typeof refreshedCookies) => void };
    },
  ) => ({
    auth: {
      // Mirrors real auth-js: an expired access token is transparently
      // refreshed inside getUser(), which rotates the refresh token and
      // pushes the new cookies through setAll() before resolving.
      getUser: async () => {
        getUserCalls++;
        if (refreshedCookies.length) opts.cookies.setAll(refreshedCookies);
        return { data: { user: mockUser }, error: mockAuthError };
      },
    },
  }),
}));

// Imported after the mock is registered.
const { middleware } = await import("./middleware");

beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://test.supabase.co";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon-key";
  mockUser = null;
  mockAuthError = null;
  refreshedCookies = [];
  getUserCalls = 0;
  __resetSessionChecksForTests();
});

afterEach(() => vi.clearAllMocks());

const ROTATED = {
  name: "sb-test-auth-token",
  value: "rotated-refresh-token",
  options: { path: "/", httpOnly: true },
};

describe("middleware — refreshed auth cookies survive redirects", () => {
  it("carries the rotated token when redirecting a signed-in user off /login", async () => {
    mockUser = { id: "user-1" };
    refreshedCookies = [ROTATED];

    const res = await middleware(
      new NextRequest("https://app.test/login"),
    );

    // Redirect to /dashboard…
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain("/dashboard");
    // …and the rotated cookie MUST ride along, otherwise the browser keeps
    // replaying the now-consumed refresh token and the session wedges until
    // the user manually clears cookies.
    expect(res.cookies.get(ROTATED.name)?.value).toBe(ROTATED.value);
  });

  it("carries the rotated token when redirecting an unauth user to /login", async () => {
    mockUser = null;
    // Even on the logged-out path getUser() may emit cookie writes (e.g.
    // clearing a dead session); those must not be dropped on the redirect.
    refreshedCookies = [{ ...ROTATED, value: "cleared" }];

    const res = await middleware(
      new NextRequest("https://app.test/dashboard"),
    );

    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain("/login");
    expect(res.cookies.get(ROTATED.name)?.value).toBe("cleared");
  });

  it("redirects a signed-in user with an invite token to /join/<token>", async () => {
    mockUser = { id: "user-1" };
    refreshedCookies = [ROTATED];

    const res = await middleware(
      new NextRequest("https://app.test/login?invite=abc123"),
    );

    expect(res.headers.get("location")).toContain("/join/abc123");
    expect(res.cookies.get(ROTATED.name)?.value).toBe(ROTATED.value);
  });

  it("passes through (no redirect) for a signed-in user on a protected page", async () => {
    mockUser = { id: "user-1" };
    refreshedCookies = [ROTATED];

    // Request an already-locale-prefixed path: with next-intl's
    // localePrefix "always", a bare /dashboard would 307 to /en/dashboard,
    // so we hit /en/dashboard directly to exercise the genuine pass-through.
    const res = await middleware(
      new NextRequest("https://app.test/en/dashboard"),
    );

    // No redirect — the normal NextResponse.next() already carries cookies.
    expect(res.headers.get("location")).toBeNull();
    expect(res.cookies.get(ROTATED.name)?.value).toBe(ROTATED.value);
  });
});

describe("middleware — Supabase being unreachable is not a logout", () => {
  it("does not redirect a page request to /login", async () => {
    mockAuthError = new AuthRetryableFetchError("fetch failed", 503);

    const res = await middleware(
      new NextRequest("https://app.test/en/dashboard"),
    );

    expect(res.headers.get("location")).toBeNull();
  });

  it("answers an API request with a retryable 503 rather than 401", async () => {
    mockAuthError = new AuthRetryableFetchError("fetch failed", 503);

    const res = await middleware(
      new NextRequest("https://app.test/api/whatsapp/send"),
    );

    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe("5");
  });

  it("does not interfere with the signature-checked webhook", async () => {
    mockAuthError = new AuthRetryableFetchError("fetch failed", 503);

    const res = await middleware(
      new NextRequest("https://app.test/api/whatsapp/webhook"),
    );

    expect(res.status).toBe(200);
  });

  it("still redirects when the session is really gone", async () => {
    mockAuthError = new Error("refresh_token_not_found");

    const res = await middleware(
      new NextRequest("https://app.test/en/dashboard"),
    );

    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain("/login");
  });
});

describe("middleware — a lost session", () => {
  const withSession = (url: string) =>
    new NextRequest(url, {
      headers: { cookie: "sb-test-auth-token=dead-token" },
    });

  it("tells the login page why, and where to return to", async () => {
    vi.spyOn(console, "warn").mockImplementationOnce(() => {});
    mockAuthError = Object.assign(new Error("Invalid Refresh Token"), {
      code: "refresh_token_not_found",
    });

    const res = await middleware(withSession("https://app.test/en/inbox"));

    const location = new URL(res.headers.get("location")!);
    expect(location.pathname).toContain("/login");
    expect(location.searchParams.get("reason")).toBe("session_expired");
    expect(location.searchParams.get("next")).toBe("/en/inbox");
  });

  it("logs the failure code and never the token", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementationOnce(() => {});
    mockAuthError = Object.assign(new Error("Invalid Refresh Token"), {
      code: "refresh_token_not_found",
    });

    await middleware(withSession("https://app.test/en/inbox"));

    const logged = warn.mock.calls.flat().join(" ");
    expect(logged).toContain("auth.refresh_failed");
    expect(logged).toContain("refresh_token_not_found");
    expect(logged).not.toContain("dead-token");
  });

  it("adds no reason for a visitor who simply isn't signed in", async () => {
    const res = await middleware(new NextRequest("https://app.test/en/inbox"));

    expect(res.headers.get("location")).not.toContain("reason=");
  });
});

describe("middleware — concurrent requests with one session", () => {
  it("refreshes once, and gives every response the new token", async () => {
    mockUser = { id: "user-1" };
    refreshedCookies = [ROTATED];
    const request = () =>
      new NextRequest("https://app.test/api/whatsapp/media/1", {
        headers: { cookie: "sb-test-auth-token=expired-token" },
      });

    const responses = await Promise.all([
      middleware(request()),
      middleware(request()),
      middleware(request()),
    ]);

    expect(getUserCalls).toBe(1);
    for (const res of responses) {
      expect(res.cookies.get(ROTATED.name)?.value).toBe(ROTATED.value);
    }
  });
});

describe("middleware — every dashboard route requires a session", () => {
  // Read the route group rather than hard-coding a list, so a new page added
  // under src/app/[locale]/(dashboard)/ fails here until it is added to
  // protectedSegments. /flows, /agents and /notifications were missed that way
  // and rendered a broken page to signed-out visitors instead of redirecting.
  const dashboardRoutes = readdirSync(join(__dirname, "app", "[locale]", "(dashboard)"), {
    withFileTypes: true,
  })
    .filter((entry) => entry.isDirectory())
    .map((entry) => `/${entry.name}`);

  it("finds the dashboard route group", () => {
    expect(dashboardRoutes).toContain("/dashboard");
  });

  it.each(dashboardRoutes)("redirects a signed-out visitor from %s to /login", async (route) => {
    mockUser = null;

    const res = await middleware(new NextRequest(`https://app.test/en${route}`));

    expect(res.status).toBe(307);
    expect(new URL(res.headers.get("location")!).pathname).toBe("/en/login");
  });
});
