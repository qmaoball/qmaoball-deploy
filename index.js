// server/_core/index.ts
import "dotenv/config";
import express2 from "express";
import { createServer } from "http";
import net from "net";
import { createExpressMiddleware } from "@trpc/server/adapters/express";

// server/_core/adminAuth.ts
import { createHash, timingSafeEqual as timingSafeEqual2 } from "node:crypto";

// shared/const.ts
var COOKIE_NAME = "app_session_id";
var ONE_YEAR_MS = 1e3 * 60 * 60 * 24 * 365;
var UNAUTHED_ERR_MSG = "Please login (10001)";
var NOT_ADMIN_ERR_MSG = "You do not have required permission (10002)";

// server/db.ts
import {
  eq,
  desc,
  and,
  or,
  gte,
  ne,
  asc,
  inArray
} from "drizzle-orm";
import { drizzle } from "drizzle-orm/mysql2";

// drizzle/schema.ts
import {
  boolean,
  int,
  mysqlEnum,
  mysqlTable,
  text,
  timestamp,
  varchar
} from "drizzle-orm/mysql-core";
var users = mysqlTable("users", {
  /**
   * Surrogate primary key. Auto-incremented numeric value managed by the database.
   * Use this for relations between tables.
   */
  id: int("id").autoincrement().primaryKey(),
  /** Stable identifier used by the site's authentication provider. */
  openId: varchar("openId", { length: 64 }).notNull().unique(),
  name: text("name"),
  email: varchar("email", { length: 320 }),
  loginMethod: varchar("loginMethod", { length: 64 }),
  role: mysqlEnum("role", ["user", "admin"]).default("user").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  lastSignedIn: timestamp("lastSignedIn").defaultNow().notNull()
});
var dailyPicks = mysqlTable("daily_picks", {
  id: int("id").autoincrement().primaryKey(),
  /** 比賽日期 (台灣時間，格式如 2026-03-17) */
  gameDate: varchar("gameDate", { length: 10 }).notNull(),
  /** 比賽時間 (台灣時間，格式如 19:00，可選) */
  gameTime: varchar("gameTime", { length: 5 }),
  /** 聯賽類型 */
  league: mysqlEnum("league", [
    "NBA",
    "WNBA",
    "KBL",
    "CBA",
    "MLB",
    "NPB",
    "KBO",
    "Soccer",
    "WBC",
    "WorldCup2026",
    "Other"
  ]).notNull(),
  /** 主隊名稱 */
  homeTeam: varchar("homeTeam", { length: 100 }).notNull(),
  /** 客隊名稱 */
  awayTeam: varchar("awayTeam", { length: 100 }).notNull(),
  /** 盤口類型：讓分 (spread) / 總分 (total) / 獨贏 (moneyline) */
  pickType: mysqlEnum("pickType", ["spread", "total", "moneyline"]).notNull(),
  /** 推薦方向，例如「湖人 +2.5」或「大 219.5」 */
  pickDirection: varchar("pickDirection", { length: 200 }).notNull(),
  /** 簡短分析理由 */
  analysis: text("analysis").notNull(),
  /** 信心等級 1-10（10 顆星滿星） */
  confidence: int("confidence").notNull().default(5),
  /** 推薦結果：pending / win / lose / push */
  result: mysqlEnum("result", ["pending", "win", "lose", "push"]).default("pending").notNull(),
  /** 是否公開顯示 */
  isPublished: boolean("isPublished").default(true).notNull(),
  /** 是否納入經驗證的公開紀錄白名單；舊資料及非後台來源預設不納入。 */
  isPublic: boolean("isPublic").default(false).notNull(),
  /** 建立者 ID (管理員) */
  createdBy: int("createdBy"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull()
});
var featuredVideos = mysqlTable("featured_videos", {
  id: int("id").autoincrement().primaryKey(),
  /** 影片標題 */
  title: varchar("title", { length: 200 }).notNull(),
  /** 影片描述 */
  description: text("description"),
  /** IG Reels 或影片 URL */
  videoUrl: varchar("videoUrl", { length: 500 }).notNull(),
  /** 縮圖 URL（可選） */
  thumbnailUrl: varchar("thumbnailUrl", { length: 500 }),
  /** 影片類型：ig_reel / youtube / other */
  videoType: mysqlEnum("videoType", ["ig_reel", "youtube", "other"]).default("ig_reel").notNull(),
  /** 排序順序（數字越小越前面） */
  sortOrder: int("sortOrder").default(0).notNull(),
  /** 是否顯示 */
  isActive: boolean("isActive").default(true).notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull()
});

// server/db.ts
var _db = null;
async function getDb() {
  if (!_db && process.env.DATABASE_URL) {
    try {
      _db = drizzle(process.env.DATABASE_URL);
    } catch (error) {
      console.warn("[Database] Failed to connect:", error);
      _db = null;
    }
  }
  return _db;
}
async function upsertUser(user) {
  if (!user.openId) {
    throw new Error("User openId is required for upsert");
  }
  const db = await getDb();
  if (!db) {
    console.warn("[Database] Cannot upsert user: database not available");
    return;
  }
  try {
    const values = {
      openId: user.openId
    };
    const updateSet = {};
    const textFields = ["name", "email", "loginMethod"];
    const assignNullable = (field) => {
      const value = user[field];
      if (value === void 0) return;
      const normalized = value ?? null;
      values[field] = normalized;
      updateSet[field] = normalized;
    };
    textFields.forEach(assignNullable);
    if (user.lastSignedIn !== void 0) {
      values.lastSignedIn = user.lastSignedIn;
      updateSet.lastSignedIn = user.lastSignedIn;
    }
    if (user.role !== void 0) {
      values.role = user.role;
      updateSet.role = user.role;
    }
    if (!values.lastSignedIn) {
      values.lastSignedIn = /* @__PURE__ */ new Date();
    }
    if (Object.keys(updateSet).length === 0) {
      updateSet.lastSignedIn = /* @__PURE__ */ new Date();
    }
    await db.insert(users).values(values).onDuplicateKeyUpdate({
      set: updateSet
    });
  } catch (error) {
    console.error("[Database] Failed to upsert user:", error);
    throw error;
  }
}
async function getUserByOpenId(openId) {
  const db = await getDb();
  if (!db) {
    console.warn("[Database] Cannot get user: database not available");
    return void 0;
  }
  const result = await db.select().from(users).where(eq(users.openId, openId)).limit(1);
  return result.length > 0 ? result[0] : void 0;
}
async function getPublishedPicks(limit = 10) {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(dailyPicks).where(eq(dailyPicks.isPublished, true)).orderBy(desc(dailyPicks.gameDate), desc(dailyPicks.createdAt)).limit(limit);
}
async function getAllPublishedRecordPicks() {
  const db = await getDb();
  if (!db) throw new Error("Database not available for public record");
  const settledResults = inArray(dailyPicks.result, ["win", "lose", "push"]);
  const resultCondition = or(
    settledResults,
    and(eq(dailyPicks.result, "pending"), eq(dailyPicks.isPublished, true))
  );
  return db.select({
    id: dailyPicks.id,
    gameDate: dailyPicks.gameDate,
    homeTeam: dailyPicks.homeTeam,
    awayTeam: dailyPicks.awayTeam,
    pickDirection: dailyPicks.pickDirection,
    result: dailyPicks.result,
    league: dailyPicks.league,
    analysis: dailyPicks.analysis,
    confidence: dailyPicks.confidence,
    pickType: dailyPicks.pickType,
    gameTime: dailyPicks.gameTime
  }).from(dailyPicks).where(and(gte(dailyPicks.gameDate, "2026-10-01"), resultCondition)).orderBy(
    desc(dailyPicks.gameDate),
    desc(dailyPicks.createdAt),
    desc(dailyPicks.id)
  );
}
async function getAllPicks(limit = 50) {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(dailyPicks).orderBy(desc(dailyPicks.gameDate), desc(dailyPicks.createdAt)).limit(limit);
}
async function createPick(pick) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const result = await db.insert(dailyPicks).values(pick);
  return result;
}
async function updatePick(id, data) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  await db.update(dailyPicks).set(data).where(eq(dailyPicks.id, id));
}
async function deletePick(id) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  await db.delete(dailyPicks).where(eq(dailyPicks.id, id));
}
async function getPickById(id) {
  const db = await getDb();
  if (!db) return void 0;
  const result = await db.select().from(dailyPicks).where(eq(dailyPicks.id, id)).limit(1);
  return result.length > 0 ? result[0] : void 0;
}
async function getActiveVideos() {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(featuredVideos).where(eq(featuredVideos.isActive, true)).orderBy(asc(featuredVideos.sortOrder), desc(featuredVideos.createdAt));
}
async function getAllVideos() {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(featuredVideos).orderBy(asc(featuredVideos.sortOrder), desc(featuredVideos.createdAt));
}
async function createVideo(video) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  return db.insert(featuredVideos).values(video);
}
async function updateVideo(id, data) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  await db.update(featuredVideos).set(data).where(eq(featuredVideos.id, id));
}
async function deleteVideo(id) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  await db.delete(featuredVideos).where(eq(featuredVideos.id, id));
}
async function getPickStats() {
  const db = await getDb();
  if (!db)
    return {
      total: 0,
      wins: 0,
      losses: 0,
      pushes: 0,
      pending: 0,
      winRate: 0,
      byLeague: []
    };
  const allSettled = await db.select().from(dailyPicks).where(
    and(eq(dailyPicks.isPublished, true), ne(dailyPicks.result, "pending"))
  );
  const wins = allSettled.filter((p) => p.result === "win").length;
  const losses = allSettled.filter((p) => p.result === "lose").length;
  const pushes = allSettled.filter((p) => p.result === "push").length;
  const total = allSettled.length;
  const winRate = total > 0 ? Math.round(wins / (wins + losses) * 1e3) / 10 : 0;
  const pendingRows = await db.select().from(dailyPicks).where(
    and(eq(dailyPicks.isPublished, true), eq(dailyPicks.result, "pending"))
  );
  const leagues = [
    "NBA",
    "WNBA",
    "KBL",
    "CBA",
    "MLB",
    "NPB",
    "KBO",
    "Soccer",
    "WBC",
    "WorldCup2026",
    "Other"
  ];
  const byLeague = leagues.map((league) => {
    const leaguePicks = allSettled.filter((p) => p.league === league);
    const lWins = leaguePicks.filter((p) => p.result === "win").length;
    const lLosses = leaguePicks.filter((p) => p.result === "lose").length;
    const lTotal = leaguePicks.length;
    const lWinRate = lTotal > 0 ? Math.round(lWins / (lWins + lLosses) * 1e3) / 10 : 0;
    return {
      league,
      total: lTotal,
      wins: lWins,
      losses: lLosses,
      winRate: lWinRate
    };
  }).filter((l) => l.total > 0);
  const recentSettled = await db.select().from(dailyPicks).where(
    and(eq(dailyPicks.isPublished, true), ne(dailyPicks.result, "pending"))
  ).orderBy(desc(dailyPicks.gameDate), desc(dailyPicks.createdAt)).limit(20);
  const monthMap = /* @__PURE__ */ new Map();
  for (const p of allSettled) {
    const month = p.gameDate.substring(0, 7);
    if (!monthMap.has(month)) monthMap.set(month, []);
    monthMap.get(month).push(p);
  }
  const monthlyBreakdown = Array.from(monthMap.entries()).sort((a, b) => b[0].localeCompare(a[0])).map(([month, picks]) => {
    const mWins = picks.filter((p) => p.result === "win").length;
    const mLosses = picks.filter((p) => p.result === "lose").length;
    const mPushes = picks.filter((p) => p.result === "push").length;
    const mTotal = picks.length;
    const mWinRate = mTotal > 0 ? Math.round(mWins / (mWins + mLosses) * 1e3) / 10 : 0;
    const mByLeague = leagues.map((league) => {
      const lPicks = picks.filter((p) => p.league === league);
      const lW = lPicks.filter((p) => p.result === "win").length;
      const lL = lPicks.filter((p) => p.result === "lose").length;
      const lT = lPicks.length;
      const lR = lT > 0 ? Math.round(lW / (lW + lL) * 1e3) / 10 : 0;
      return { league, total: lT, wins: lW, losses: lL, winRate: lR };
    }).filter((l) => l.total > 0);
    return {
      month,
      total: mTotal,
      wins: mWins,
      losses: mLosses,
      pushes: mPushes,
      winRate: mWinRate,
      byLeague: mByLeague
    };
  });
  return {
    total,
    wins,
    losses,
    pushes,
    pending: pendingRows.length,
    winRate,
    byLeague,
    monthlyBreakdown,
    recentResults: recentSettled.map((p) => ({
      id: p.id,
      gameDate: p.gameDate,
      league: p.league,
      homeTeam: p.homeTeam,
      awayTeam: p.awayTeam,
      pickDirection: p.pickDirection,
      pickType: p.pickType,
      result: p.result,
      confidence: p.confidence
    }))
  };
}

// server/_core/env.ts
var ENV = {
  appId: process.env.VITE_APP_ID ?? "qmaoball",
  cookieSecret: process.env.JWT_SECRET ?? "",
  databaseUrl: process.env.DATABASE_URL ?? "",
  adminUsername: process.env.ADMIN_USERNAME ?? "qmaoball",
  adminPasswordHash: process.env.ADMIN_PASSWORD_HASH ?? "",
  adminOpenId: process.env.ADMIN_OPEN_ID ?? "qmaoball-admin",
  isProduction: process.env.NODE_ENV === "production",
  forgeApiUrl: process.env.BUILT_IN_FORGE_API_URL ?? "",
  forgeApiKey: process.env.BUILT_IN_FORGE_API_KEY ?? ""
};

// server/_core/cookies.ts
function isSecureRequest(req) {
  if (req.protocol === "https") return true;
  const forwardedProto = req.headers["x-forwarded-proto"];
  if (!forwardedProto) return false;
  const protoList = Array.isArray(forwardedProto) ? forwardedProto : forwardedProto.split(",");
  return protoList.some((proto) => proto.trim().toLowerCase() === "https");
}
function getSessionCookieOptions(req) {
  return {
    httpOnly: true,
    path: "/",
    sameSite: "lax",
    secure: isSecureRequest(req)
  };
}

// server/_core/password.ts
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
var KEY_LENGTH = 64;
var FORMAT = "scrypt";
function verifyPasswordHash(password, encodedHash) {
  const [format, saltText, hashText, extra] = encodedHash.split("$");
  if (format !== FORMAT || !saltText || !hashText || extra !== void 0)
    return false;
  try {
    const salt = Buffer.from(saltText, "base64url");
    const expected = Buffer.from(hashText, "base64url");
    if (expected.length !== KEY_LENGTH) return false;
    const actual = scryptSync(password, salt, expected.length);
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

// shared/_core/errors.ts
var HttpError = class extends Error {
  constructor(statusCode, message) {
    super(message);
    this.statusCode = statusCode;
    this.name = "HttpError";
  }
};
var ForbiddenError = (msg) => new HttpError(403, msg);

// server/_core/sdk.ts
import { parse as parseCookieHeader } from "cookie";
import { SignJWT, jwtVerify } from "jose";
var isNonEmptyString = (value) => typeof value === "string" && value.length > 0;
var SDKServer = class {
  parseCookies(cookieHeader) {
    if (!cookieHeader) return /* @__PURE__ */ new Map();
    return new Map(Object.entries(parseCookieHeader(cookieHeader)));
  }
  getSessionSecret() {
    if (ENV.cookieSecret.length < 32) {
      throw new Error("JWT_SECRET must contain at least 32 characters");
    }
    return new TextEncoder().encode(ENV.cookieSecret);
  }
  async createSessionToken(openId, options = {}) {
    return this.signSession(
      {
        openId,
        appId: ENV.appId,
        name: options.name || "\u7BA1\u7406\u54E1"
      },
      options
    );
  }
  async signSession(payload, options = {}) {
    const issuedAt = Date.now();
    const expiresInMs = options.expiresInMs ?? ONE_YEAR_MS;
    const expirationSeconds = Math.floor((issuedAt + expiresInMs) / 1e3);
    return new SignJWT(payload).setProtectedHeader({ alg: "HS256", typ: "JWT" }).setIssuedAt(Math.floor(issuedAt / 1e3)).setExpirationTime(expirationSeconds).sign(this.getSessionSecret());
  }
  async verifySession(cookieValue) {
    if (!cookieValue) return null;
    try {
      const { payload } = await jwtVerify(
        cookieValue,
        this.getSessionSecret(),
        {
          algorithms: ["HS256"]
        }
      );
      const { openId, appId, name } = payload;
      if (!isNonEmptyString(openId) || !isNonEmptyString(appId) || !isNonEmptyString(name)) {
        return null;
      }
      if (appId !== ENV.appId) return null;
      return { openId, appId, name };
    } catch {
      return null;
    }
  }
  async authenticateRequest(req) {
    const cookies = this.parseCookies(req.headers.cookie);
    const session = await this.verifySession(cookies.get(COOKIE_NAME));
    if (!session) throw ForbiddenError("Invalid session cookie");
    const user = await getUserByOpenId(session.openId);
    if (!user) throw ForbiddenError("User not found");
    await upsertUser({
      openId: user.openId,
      lastSignedIn: /* @__PURE__ */ new Date()
    });
    return user;
  }
};
var sdk = new SDKServer();

// server/_core/adminAuth.ts
var ADMIN_SESSION_MS = 1e3 * 60 * 60 * 24 * 30;
var ATTEMPT_WINDOW_MS = 1e3 * 60 * 15;
var MAX_ATTEMPTS = 5;
var attempts = /* @__PURE__ */ new Map();
function clientKey(req) {
  const forwarded = req.headers["x-forwarded-for"];
  const value = Array.isArray(forwarded) ? forwarded[0] : forwarded?.split(",")[0];
  return value?.trim() || req.ip || "unknown";
}
function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    const forwardedHost = req.headers["x-forwarded-host"];
    const hostValue = Array.isArray(forwardedHost) ? forwardedHost[0] : forwardedHost;
    const host = hostValue?.split(",")[0]?.trim() || req.headers.host;
    return Boolean(host) && new URL(origin).host === host;
  } catch {
    return false;
  }
}
function safeEqualText(left, right) {
  const leftDigest = createHash("sha256").update(left).digest();
  const rightDigest = createHash("sha256").update(right).digest();
  return timingSafeEqual2(leftDigest, rightDigest);
}
function recordFailure(key, now) {
  const current = attempts.get(key);
  if (!current || current.resetAt <= now) {
    attempts.set(key, { count: 1, resetAt: now + ATTEMPT_WINDOW_MS });
    return;
  }
  current.count += 1;
}
function registerAdminAuthRoutes(app) {
  app.post("/api/admin/login", async (req, res) => {
    if (!sameOrigin(req)) {
      res.status(403).json({ error: "Invalid request origin" });
      return;
    }
    const key = clientKey(req);
    const now = Date.now();
    const attempt = attempts.get(key);
    if (attempt && attempt.resetAt > now && attempt.count >= MAX_ATTEMPTS) {
      res.setHeader("Retry-After", Math.ceil((attempt.resetAt - now) / 1e3));
      res.status(429).json({ error: "Too many login attempts. Please try again later." });
      return;
    }
    const username = typeof req.body?.username === "string" ? req.body.username : "";
    const password = typeof req.body?.password === "string" ? req.body.password : "";
    const configured = Boolean(
      ENV.adminUsername && ENV.adminPasswordHash && ENV.cookieSecret
    );
    const valid = configured && safeEqualText(username, ENV.adminUsername) && verifyPasswordHash(password, ENV.adminPasswordHash);
    if (!valid) {
      recordFailure(key, now);
      res.status(401).json({ error: "\u5E33\u865F\u6216\u5BC6\u78BC\u932F\u8AA4" });
      return;
    }
    attempts.delete(key);
    const signedInAt = /* @__PURE__ */ new Date();
    await upsertUser({
      openId: ENV.adminOpenId,
      name: "\u6372\u6BDB\u53D4\u7BA1\u7406\u54E1",
      email: null,
      loginMethod: "password",
      role: "admin",
      lastSignedIn: signedInAt
    });
    const sessionToken = await sdk.createSessionToken(ENV.adminOpenId, {
      name: "\u6372\u6BDB\u53D4\u7BA1\u7406\u54E1",
      expiresInMs: ADMIN_SESSION_MS
    });
    const cookieOptions = getSessionCookieOptions(req);
    res.cookie(COOKIE_NAME, sessionToken, {
      ...cookieOptions,
      maxAge: ADMIN_SESSION_MS
    });
    res.json({ success: true });
  });
}

// server/_core/systemRouter.ts
import { z } from "zod";

// server/_core/notification.ts
import { TRPCError } from "@trpc/server";
var TITLE_MAX_LENGTH = 1200;
var CONTENT_MAX_LENGTH = 2e4;
var trimValue = (value) => value.trim();
var isNonEmptyString2 = (value) => typeof value === "string" && value.trim().length > 0;
var buildEndpointUrl = (baseUrl) => {
  const normalizedBase = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  return new URL(
    "webdevtoken.v1.WebDevService/SendNotification",
    normalizedBase
  ).toString();
};
var validatePayload = (input) => {
  if (!isNonEmptyString2(input.title)) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Notification title is required."
    });
  }
  if (!isNonEmptyString2(input.content)) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Notification content is required."
    });
  }
  const title = trimValue(input.title);
  const content = trimValue(input.content);
  if (title.length > TITLE_MAX_LENGTH) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `Notification title must be at most ${TITLE_MAX_LENGTH} characters.`
    });
  }
  if (content.length > CONTENT_MAX_LENGTH) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `Notification content must be at most ${CONTENT_MAX_LENGTH} characters.`
    });
  }
  return { title, content };
};
async function notifyOwner(payload) {
  const { title, content } = validatePayload(payload);
  if (!ENV.forgeApiUrl) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "Notification service URL is not configured."
    });
  }
  if (!ENV.forgeApiKey) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "Notification service API key is not configured."
    });
  }
  const endpoint = buildEndpointUrl(ENV.forgeApiUrl);
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${ENV.forgeApiKey}`,
        "content-type": "application/json",
        "connect-protocol-version": "1"
      },
      body: JSON.stringify({ title, content })
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      console.warn(
        `[Notification] Failed to notify owner (${response.status} ${response.statusText})${detail ? `: ${detail}` : ""}`
      );
      return false;
    }
    return true;
  } catch (error) {
    console.warn("[Notification] Error calling notification service:", error);
    return false;
  }
}

// server/_core/trpc.ts
import { initTRPC, TRPCError as TRPCError2 } from "@trpc/server";
import superjson from "superjson";
var t = initTRPC.context().create({
  transformer: superjson
});
var router = t.router;
var publicProcedure = t.procedure;
var requireUser = t.middleware(async (opts) => {
  const { ctx, next } = opts;
  if (!ctx.user) {
    throw new TRPCError2({ code: "UNAUTHORIZED", message: UNAUTHED_ERR_MSG });
  }
  return next({
    ctx: {
      ...ctx,
      user: ctx.user
    }
  });
});
var protectedProcedure = t.procedure.use(requireUser);
var adminProcedure = t.procedure.use(
  t.middleware(async (opts) => {
    const { ctx, next } = opts;
    if (!ctx.user || ctx.user.role !== "admin") {
      throw new TRPCError2({ code: "FORBIDDEN", message: NOT_ADMIN_ERR_MSG });
    }
    return next({
      ctx: {
        ...ctx,
        user: ctx.user
      }
    });
  })
);

// server/_core/systemRouter.ts
var systemRouter = router({
  health: publicProcedure.input(
    z.object({
      timestamp: z.number().min(0, "timestamp cannot be negative")
    })
  ).query(() => ({
    ok: true
  })),
  notifyOwner: adminProcedure.input(
    z.object({
      title: z.string().min(1, "title is required"),
      content: z.string().min(1, "content is required")
    })
  ).mutation(async ({ input }) => {
    const delivered = await notifyOwner(input);
    return {
      success: delivered
    };
  })
});

// server/_core/llm.ts
var ensureArray = (value) => Array.isArray(value) ? value : [value];
var normalizeContentPart = (part) => {
  if (typeof part === "string") {
    return { type: "text", text: part };
  }
  if (part.type === "text") {
    return part;
  }
  if (part.type === "image_url") {
    return part;
  }
  if (part.type === "file_url") {
    return part;
  }
  throw new Error("Unsupported message content part");
};
var normalizeMessage = (message) => {
  const { role, name, tool_call_id } = message;
  if (role === "tool" || role === "function") {
    const content = ensureArray(message.content).map((part) => typeof part === "string" ? part : JSON.stringify(part)).join("\n");
    return {
      role,
      name,
      tool_call_id,
      content
    };
  }
  const contentParts = ensureArray(message.content).map(normalizeContentPart);
  if (contentParts.length === 1 && contentParts[0].type === "text") {
    return {
      role,
      name,
      content: contentParts[0].text
    };
  }
  return {
    role,
    name,
    content: contentParts
  };
};
var normalizeToolChoice = (toolChoice, tools) => {
  if (!toolChoice) return void 0;
  if (toolChoice === "none" || toolChoice === "auto") {
    return toolChoice;
  }
  if (toolChoice === "required") {
    if (!tools || tools.length === 0) {
      throw new Error(
        "tool_choice 'required' was provided but no tools were configured"
      );
    }
    if (tools.length > 1) {
      throw new Error(
        "tool_choice 'required' needs a single tool or specify the tool name explicitly"
      );
    }
    return {
      type: "function",
      function: { name: tools[0].function.name }
    };
  }
  if ("name" in toolChoice) {
    return {
      type: "function",
      function: { name: toolChoice.name }
    };
  }
  return toolChoice;
};
var resolveApiUrl = () => ENV.forgeApiUrl && ENV.forgeApiUrl.trim().length > 0 ? `${ENV.forgeApiUrl.replace(/\/$/, "")}/v1/chat/completions` : "https://forge.manus.im/v1/chat/completions";
var assertApiKey = () => {
  if (!ENV.forgeApiKey) {
    throw new Error("OPENAI_API_KEY is not configured");
  }
};
var normalizeResponseFormat = ({
  responseFormat,
  response_format,
  outputSchema,
  output_schema
}) => {
  const explicitFormat = responseFormat || response_format;
  if (explicitFormat) {
    if (explicitFormat.type === "json_schema" && !explicitFormat.json_schema?.schema) {
      throw new Error(
        "responseFormat json_schema requires a defined schema object"
      );
    }
    return explicitFormat;
  }
  const schema = outputSchema || output_schema;
  if (!schema) return void 0;
  if (!schema.name || !schema.schema) {
    throw new Error("outputSchema requires both name and schema");
  }
  return {
    type: "json_schema",
    json_schema: {
      name: schema.name,
      schema: schema.schema,
      ...typeof schema.strict === "boolean" ? { strict: schema.strict } : {}
    }
  };
};
async function invokeLLM(params) {
  assertApiKey();
  const {
    messages,
    tools,
    toolChoice,
    tool_choice,
    outputSchema,
    output_schema,
    responseFormat,
    response_format
  } = params;
  const payload = {
    model: "gemini-2.5-flash",
    messages: messages.map(normalizeMessage)
  };
  if (tools && tools.length > 0) {
    payload.tools = tools;
  }
  const normalizedToolChoice = normalizeToolChoice(
    toolChoice || tool_choice,
    tools
  );
  if (normalizedToolChoice) {
    payload.tool_choice = normalizedToolChoice;
  }
  payload.max_tokens = 32768;
  payload.thinking = {
    "budget_tokens": 128
  };
  const normalizedResponseFormat = normalizeResponseFormat({
    responseFormat,
    response_format,
    outputSchema,
    output_schema
  });
  if (normalizedResponseFormat) {
    payload.response_format = normalizedResponseFormat;
  }
  const response = await fetch(resolveApiUrl(), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${ENV.forgeApiKey}`
    },
    body: JSON.stringify(payload)
  });
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `LLM invoke failed: ${response.status} ${response.statusText} \u2013 ${errorText}`
    );
  }
  return await response.json();
}

// server/autoSettlement.ts
import { eq as eq2, and as and2 } from "drizzle-orm";
function getYesterdayTW() {
  const now = /* @__PURE__ */ new Date();
  const twMs = now.getTime() + 8 * 60 * 60 * 1e3 - 24 * 60 * 60 * 1e3;
  const tw = new Date(twMs);
  return tw.toISOString().slice(0, 10);
}
async function fetchGameResultViaLLM(league, homeTeam, awayTeam, gameDate) {
  try {
    const response = await invokeLLM({
      messages: [
        {
          role: "system",
          content: `\u4F60\u662F\u4E00\u500B\u9AD4\u80B2\u8CFD\u4E8B\u7D50\u679C\u67E5\u8A62\u52A9\u624B\u3002\u8ACB\u67E5\u8A62\u4EE5\u4E0B\u6BD4\u8CFD\u7684\u6700\u7D42\u6BD4\u5206\u7D50\u679C\u3002
\u4F60\u5FC5\u9808\u56DE\u8986\u7CBE\u78BA\u7684\u6BD4\u5206\u6578\u5B57\u3002\u5982\u679C\u6BD4\u8CFD\u5C1A\u672A\u7D50\u675F\u3001\u88AB\u53D6\u6D88\u3001\u6216\u4F60\u7121\u6CD5\u78BA\u8A8D\u7D50\u679C\uFF0C\u8ACB\u5982\u5BE6\u56DE\u5831\u3002

\u91CD\u8981\uFF1A
- \u53EA\u56DE\u5831\u6700\u7D42\u6BD4\u5206\uFF08\u542B\u52A0\u6642\u8CFD\u7684\u7E3D\u5206\uFF09
- \u5982\u679C\u662F\u68D2\u7403\uFF0C\u56DE\u5831\u6700\u7D42\u6BD4\u5206\uFF08\u542B\u5EF6\u9577\u8CFD\uFF09
- \u5982\u679C\u662F\u8DB3\u7403\uFF0C\u56DE\u5831 90 \u5206\u9418\u6B63\u898F\u6642\u9593\u6BD4\u5206\uFF08\u4E0D\u542B\u52A0\u6642\u548C\u9EDE\u7403\uFF09
- \u5FC5\u9808\u4EE5 JSON \u683C\u5F0F\u56DE\u8986`
        },
        {
          role: "user",
          content: `\u8ACB\u67E5\u8A62\u4EE5\u4E0B\u6BD4\u8CFD\u7684\u6700\u7D42\u7D50\u679C\uFF1A

\u806F\u8CFD\uFF1A${league}
\u6BD4\u8CFD\u65E5\u671F\uFF1A${gameDate}
\u4E3B\u968A\uFF1A${homeTeam}
\u5BA2\u968A\uFF1A${awayTeam}

\u8ACB\u4EE5 JSON \u683C\u5F0F\u56DE\u8986\u6BD4\u8CFD\u7D50\u679C\u3002`
        }
      ],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "game_result",
          strict: true,
          schema: {
            type: "object",
            properties: {
              homeScore: {
                type: "integer",
                description: "\u4E3B\u968A\u6700\u7D42\u5F97\u5206\uFF08\u6574\u6578\uFF09"
              },
              awayScore: {
                type: "integer",
                description: "\u5BA2\u968A\u6700\u7D42\u5F97\u5206\uFF08\u6574\u6578\uFF09"
              },
              status: {
                type: "string",
                enum: ["finished", "not_found", "not_finished", "cancelled"],
                description: "\u6BD4\u8CFD\u72C0\u614B\uFF1Afinished=\u5DF2\u7D50\u675F, not_found=\u67E5\u7121\u6B64\u8CFD\u4E8B, not_finished=\u5C1A\u672A\u7D50\u675F, cancelled=\u5DF2\u53D6\u6D88"
              },
              statusReason: {
                type: "string",
                description: "\u72C0\u614B\u8AAA\u660E\uFF08\u4F8B\u5982\uFF1A\u6BD4\u8CFD\u5EF6\u671F\u3001\u67E5\u7121\u8CC7\u6599\u7B49\uFF09"
              }
            },
            required: ["homeScore", "awayScore", "status", "statusReason"],
            additionalProperties: false
          }
        }
      }
    });
    const content = response.choices[0]?.message?.content;
    if (!content || typeof content !== "string") {
      return { homeScore: 0, awayScore: 0, status: "not_found", source: "LLM \u56DE\u61C9\u70BA\u7A7A" };
    }
    const parsed = JSON.parse(content);
    return {
      homeScore: parsed.homeScore ?? 0,
      awayScore: parsed.awayScore ?? 0,
      status: parsed.status ?? "not_found",
      source: `LLM: ${parsed.statusReason || "\u67E5\u8A62\u6210\u529F"}`
    };
  } catch (error) {
    console.error(`[Settlement] LLM query failed for ${awayTeam} @ ${homeTeam}:`, error);
    return { homeScore: 0, awayScore: 0, status: "not_found", source: `LLM \u67E5\u8A62\u5931\u6557: ${error}` };
  }
}
function parsePickDirection(pickDirection, pickType, homeTeam, awayTeam) {
  const dir = pickDirection.trim();
  if (pickType === "total") {
    const totalMatch = dir.match(/^(大|小)\s*([\d.]+)/);
    if (totalMatch) {
      return {
        direction: totalMatch[1],
        line: parseFloat(totalMatch[2])
      };
    }
    return {};
  }
  if (pickType === "moneyline") {
    const mlMatch = dir.match(/^(.+?)\s*獨贏/);
    if (mlMatch) {
      const team = mlMatch[1].trim();
      const isHome = isTeamMatch(team, homeTeam);
      return { team, isHomeTeam: isHome };
    }
    return {};
  }
  if (pickType === "spread") {
    const spreadMatch = dir.match(/^(.+?)\s*(讓|受讓|[+-])\s*([\d.]+)/);
    if (spreadMatch) {
      const team = spreadMatch[1].trim();
      const type = spreadMatch[2];
      const num = parseFloat(spreadMatch[3]);
      const isHome = isTeamMatch(team, homeTeam);
      let line;
      if (type === "\u8B93" || type === "-") {
        line = num;
      } else {
        line = -num;
      }
      return { team, line, isHomeTeam: isHome };
    }
    return {};
  }
  return {};
}
function isTeamMatch(pickTeam, dbTeam) {
  if (pickTeam === dbTeam) return true;
  if (dbTeam.includes(pickTeam) || pickTeam.includes(dbTeam)) return true;
  return false;
}
function settlePickResult(pickType, pickDirection, homeTeam, awayTeam, homeScore, awayScore) {
  const parsed = parsePickDirection(pickDirection, pickType, homeTeam, awayTeam);
  if (pickType === "total") {
    if (parsed.direction === void 0 || parsed.line === void 0) {
      return { result: "push", reason: `\u7121\u6CD5\u89E3\u6790\u76E4\u53E3\u65B9\u5411: ${pickDirection}` };
    }
    const totalScore = homeScore + awayScore;
    const line = parsed.line;
    if (parsed.direction === "\u5927") {
      if (totalScore > line) return { result: "win", reason: `\u7E3D\u5206 ${totalScore} > ${line}\uFF0C\u5927\u5206\u904E\u76E4` };
      if (totalScore < line) return { result: "lose", reason: `\u7E3D\u5206 ${totalScore} < ${line}\uFF0C\u5927\u5206\u672A\u904E` };
      return { result: "push", reason: `\u7E3D\u5206 ${totalScore} = ${line}\uFF0C\u8D70\u76E4` };
    } else {
      if (totalScore < line) return { result: "win", reason: `\u7E3D\u5206 ${totalScore} < ${line}\uFF0C\u5C0F\u5206\u904E\u76E4` };
      if (totalScore > line) return { result: "lose", reason: `\u7E3D\u5206 ${totalScore} > ${line}\uFF0C\u5C0F\u5206\u672A\u904E` };
      return { result: "push", reason: `\u7E3D\u5206 ${totalScore} = ${line}\uFF0C\u8D70\u76E4` };
    }
  }
  if (pickType === "moneyline") {
    if (parsed.team === void 0 || parsed.isHomeTeam === void 0) {
      return { result: "push", reason: `\u7121\u6CD5\u89E3\u6790\u7368\u8D0F\u65B9\u5411: ${pickDirection}` };
    }
    const pickedTeamScore = parsed.isHomeTeam ? homeScore : awayScore;
    const opponentScore = parsed.isHomeTeam ? awayScore : homeScore;
    if (pickedTeamScore > opponentScore) return { result: "win", reason: `${parsed.team} \u52DD ${pickedTeamScore}:${opponentScore}\uFF0C\u7368\u8D0F\u904E\u76E4` };
    if (pickedTeamScore < opponentScore) return { result: "lose", reason: `${parsed.team} \u8CA0 ${pickedTeamScore}:${opponentScore}\uFF0C\u7368\u8D0F\u672A\u904E` };
    return { result: "push", reason: `\u5E73\u624B ${pickedTeamScore}:${opponentScore}\uFF0C\u8D70\u76E4` };
  }
  if (pickType === "spread") {
    if (parsed.team === void 0 || parsed.line === void 0 || parsed.isHomeTeam === void 0) {
      return { result: "push", reason: `\u7121\u6CD5\u89E3\u6790\u8B93\u5206\u76E4\u53E3: ${pickDirection}` };
    }
    const pickedTeamScore = parsed.isHomeTeam ? homeScore : awayScore;
    const opponentScore = parsed.isHomeTeam ? awayScore : homeScore;
    const margin = pickedTeamScore - opponentScore;
    const adjustedMargin = margin - parsed.line;
    if (adjustedMargin > 0) {
      return {
        result: "win",
        reason: `${parsed.team} ${margin > 0 ? "\u8D0F" : "\u8F38"} ${Math.abs(margin)} \u5206\uFF0C\u8B93\u5206 ${parsed.line > 0 ? "\u8B93" : "\u53D7\u8B93"}${Math.abs(parsed.line)}\uFF0C\u904E\u76E4 (\u6BD4\u5206 ${homeScore}:${awayScore})`
      };
    }
    if (adjustedMargin < 0) {
      return {
        result: "lose",
        reason: `${parsed.team} ${margin > 0 ? "\u8D0F" : "\u8F38"} ${Math.abs(margin)} \u5206\uFF0C\u8B93\u5206 ${parsed.line > 0 ? "\u8B93" : "\u53D7\u8B93"}${Math.abs(parsed.line)}\uFF0C\u672A\u904E (\u6BD4\u5206 ${homeScore}:${awayScore})`
      };
    }
    return {
      result: "push",
      reason: `${parsed.team} ${margin > 0 ? "\u8D0F" : "\u8F38"} ${Math.abs(margin)} \u5206\uFF0C\u8B93\u5206 ${parsed.line > 0 ? "\u8B93" : "\u53D7\u8B93"}${Math.abs(parsed.line)}\uFF0C\u8D70\u76E4 (\u6BD4\u5206 ${homeScore}:${awayScore})`
    };
  }
  return { result: "push", reason: `\u672A\u77E5\u76E4\u53E3\u985E\u578B: ${pickType}` };
}
async function autoSettlePicks(targetDate) {
  const date = targetDate || getYesterdayTW();
  console.log(`[Settlement] Starting auto-settlement for date: ${date}`);
  const db = await getDb();
  if (!db) {
    return { success: false, message: "\u8CC7\u6599\u5EAB\u7121\u6CD5\u9023\u7DDA", results: [] };
  }
  try {
    const pendingPicks = await db.select().from(dailyPicks).where(
      and2(
        eq2(dailyPicks.gameDate, date),
        eq2(dailyPicks.result, "pending")
      )
    );
    if (pendingPicks.length === 0) {
      console.log(`[Settlement] No pending picks for ${date}`);
      return { success: true, message: `${date} \u7121\u5F85\u7D50\u7B97\u63A8\u85A6`, results: [] };
    }
    console.log(`[Settlement] Found ${pendingPicks.length} pending picks for ${date}`);
    const results = [];
    for (const pick of pendingPicks) {
      console.log(`[Settlement] Processing: ${pick.league} ${pick.awayTeam} @ ${pick.homeTeam}`);
      const gameResult = await fetchGameResultViaLLM(
        pick.league,
        pick.homeTeam,
        pick.awayTeam,
        pick.gameDate
      );
      let settlement = "pending";
      let reason = "";
      if (gameResult.status === "finished") {
        const settleResult = settlePickResult(
          pick.pickType,
          pick.pickDirection,
          pick.homeTeam,
          pick.awayTeam,
          gameResult.homeScore,
          gameResult.awayScore
        );
        settlement = settleResult.result;
        reason = settleResult.reason;
        await db.update(dailyPicks).set({ result: settlement }).where(eq2(dailyPicks.id, pick.id));
        console.log(`[Settlement] Pick #${pick.id}: ${settlement} - ${reason}`);
      } else if (gameResult.status === "cancelled") {
        settlement = "push";
        reason = `\u6BD4\u8CFD\u53D6\u6D88/\u5EF6\u671F: ${gameResult.source}`;
        await db.update(dailyPicks).set({ result: "push" }).where(eq2(dailyPicks.id, pick.id));
        console.log(`[Settlement] Pick #${pick.id}: push (cancelled) - ${reason}`);
      } else {
        reason = `\u7121\u6CD5\u7D50\u7B97: ${gameResult.source}`;
        console.log(`[Settlement] Pick #${pick.id}: still pending - ${reason}`);
      }
      results.push({
        pickId: pick.id,
        gameDate: pick.gameDate,
        league: pick.league,
        homeTeam: pick.homeTeam,
        awayTeam: pick.awayTeam,
        pickType: pick.pickType,
        pickDirection: pick.pickDirection,
        gameResult: gameResult.status === "finished" ? gameResult : null,
        settlement,
        reason
      });
    }
    const settled = results.filter((r) => r.settlement !== "pending");
    const wins = results.filter((r) => r.settlement === "win").length;
    const losses = results.filter((r) => r.settlement === "lose").length;
    const pushes = results.filter((r) => r.settlement === "push").length;
    const stillPending = results.filter((r) => r.settlement === "pending").length;
    const summary = `${date} \u7D50\u7B97\u5B8C\u6210\uFF1A\u5171 ${results.length} \u7B46\uFF0C\u904E\u76E4 ${wins}\u3001\u672A\u904E ${losses}\u3001\u8D70\u76E4 ${pushes}\u3001\u5F85\u7D50\u7B97 ${stillPending}`;
    console.log(`[Settlement] ${summary}`);
    if (settled.length > 0) {
      const detailLines = results.map((r) => {
        const emoji = r.settlement === "win" ? "\u2705" : r.settlement === "lose" ? "\u274C" : r.settlement === "push" ? "\u2796" : "\u23F3";
        return `${emoji} ${r.league} ${r.awayTeam} vs ${r.homeTeam}\uFF1A${r.pickDirection} \u2192 ${r.reason}`;
      });
      await notifyOwner({
        title: `\u6BCF\u65E5\u7D50\u7B97\u5831\u544A ${date}`,
        content: `${summary}

${detailLines.join("\n")}`
      });
    }
    return { success: true, message: summary, results };
  } catch (error) {
    console.error("[Settlement] Error during auto-settlement:", error);
    return { success: false, message: `\u7D50\u7B97\u5931\u6557: ${error}`, results: [] };
  }
}

// server/routers.ts
import { z as z2 } from "zod";
var pickInputSchema = z2.object({
  gameDate: z2.string().min(1),
  gameTime: z2.string().nullable().optional(),
  league: z2.enum([
    "NBA",
    "WNBA",
    "KBL",
    "CBA",
    "MLB",
    "NPB",
    "KBO",
    "Soccer",
    "WBC",
    "WorldCup2026",
    "Other"
  ]),
  homeTeam: z2.string().min(1),
  awayTeam: z2.string().min(1),
  pickType: z2.enum(["spread", "total", "moneyline"]),
  pickDirection: z2.string().min(1),
  analysis: z2.string().min(1),
  confidence: z2.number().min(1).max(10).default(5),
  isPublished: z2.boolean().default(true),
  isPublic: z2.boolean().default(true)
});
var appRouter = router({
  system: systemRouter,
  auth: router({
    me: publicProcedure.query((opts) => opts.ctx.user),
    logout: publicProcedure.mutation(({ ctx }) => {
      const cookieOptions = getSessionCookieOptions(ctx.req);
      ctx.res.clearCookie(COOKIE_NAME, { ...cookieOptions, maxAge: -1 });
      return { success: true };
    })
  }),
  picks: router({
    /** 公開：取得已發布的推薦（訪客可見） */
    published: publicProcedure.input(
      z2.object({ limit: z2.number().min(1).max(50).default(10) }).optional()
    ).query(async ({ input }) => {
      return getPublishedPicks(input?.limit ?? 10);
    }),
    /** 公開：三區塊共用 2026-10-01 起的已結算及已發布待結算來源，不分頁。 */
    record: publicProcedure.query(() => getAllPublishedRecordPicks()),
    /** 公開：取得戰績統計 */
    stats: publicProcedure.query(async () => {
      return getPickStats();
    }),
    /** 管理員：取得所有推薦（含未發布） */
    all: adminProcedure.input(
      z2.object({ limit: z2.number().min(1).max(100).default(50) }).optional()
    ).query(async ({ input }) => {
      return getAllPicks(input?.limit ?? 50);
    }),
    /** 管理員：取得單筆推薦 */
    byId: adminProcedure.input(z2.object({ id: z2.number() })).query(async ({ input }) => {
      return getPickById(input.id);
    }),
    /** 管理員：新增推薦 */
    create: adminProcedure.input(pickInputSchema).mutation(async ({ input, ctx }) => {
      await createPick({
        ...input,
        createdBy: ctx.user.id
      });
      return { success: true };
    }),
    /** 管理員：更新推薦 */
    update: adminProcedure.input(
      z2.object({
        id: z2.number(),
        data: z2.object({
          gameDate: z2.string().min(1).optional(),
          gameTime: z2.string().nullable().optional(),
          league: z2.enum([
            "NBA",
            "WNBA",
            "KBL",
            "CBA",
            "MLB",
            "NPB",
            "KBO",
            "Soccer",
            "WBC",
            "WorldCup2026",
            "Other"
          ]).optional(),
          homeTeam: z2.string().min(1).optional(),
          awayTeam: z2.string().min(1).optional(),
          pickType: z2.enum(["spread", "total", "moneyline"]).optional(),
          pickDirection: z2.string().min(1).optional(),
          analysis: z2.string().min(1).optional(),
          confidence: z2.number().min(1).max(10).optional(),
          isPublished: z2.boolean().optional(),
          isPublic: z2.boolean().optional(),
          result: z2.enum(["pending", "win", "lose", "push"]).optional()
        })
      })
    ).mutation(async ({ input }) => {
      const updateData = {};
      for (const [key, value] of Object.entries(input.data)) {
        if (value !== void 0) {
          updateData[key] = value;
        }
      }
      await updatePick(input.id, updateData);
      return { success: true };
    }),
    /** 管理員：刪除推薦 */
    delete: adminProcedure.input(z2.object({ id: z2.number() })).mutation(async ({ input }) => {
      await deletePick(input.id);
      return { success: true };
    }),
    /** 管理員：手動觸發結算（指定日期或預設昨天） */
    settle: adminProcedure.input(z2.object({ date: z2.string().optional() }).optional()).mutation(async ({ input }) => {
      return autoSettlePicks(input?.date);
    })
  }),
  videos: router({
    /** 公開：取得啟用中的精選影片 */
    active: publicProcedure.query(async () => {
      return getActiveVideos();
    }),
    /** 管理員：取得所有影片 */
    all: adminProcedure.query(async () => {
      return getAllVideos();
    }),
    /** 管理員：新增影片 */
    create: adminProcedure.input(
      z2.object({
        title: z2.string().min(1),
        description: z2.string().optional(),
        videoUrl: z2.string().url(),
        thumbnailUrl: z2.string().url().optional(),
        videoType: z2.enum(["ig_reel", "youtube", "other"]).default("ig_reel"),
        sortOrder: z2.number().default(0),
        isActive: z2.boolean().default(true)
      })
    ).mutation(async ({ input }) => {
      await createVideo(input);
      return { success: true };
    }),
    /** 管理員：更新影片 */
    update: adminProcedure.input(
      z2.object({
        id: z2.number(),
        data: z2.object({
          title: z2.string().min(1).optional(),
          description: z2.string().optional(),
          videoUrl: z2.string().url().optional(),
          thumbnailUrl: z2.string().url().optional(),
          videoType: z2.enum(["ig_reel", "youtube", "other"]).optional(),
          sortOrder: z2.number().optional(),
          isActive: z2.boolean().optional()
        })
      })
    ).mutation(async ({ input }) => {
      await updateVideo(input.id, input.data);
      return { success: true };
    }),
    /** 管理員：刪除影片 */
    delete: adminProcedure.input(z2.object({ id: z2.number() })).mutation(async ({ input }) => {
      await deleteVideo(input.id);
      return { success: true };
    })
  })
});

// server/_core/context.ts
async function createContext(opts) {
  let user = null;
  try {
    user = await sdk.authenticateRequest(opts.req);
  } catch (error) {
    user = null;
  }
  return {
    req: opts.req,
    res: opts.res,
    user
  };
}

// server/_core/static.ts
import express from "express";
import fs from "node:fs";
import path from "node:path";
function serveStatic(app) {
  const distPath = process.env.NODE_ENV === "development" ? path.resolve(import.meta.dirname, "../..", "dist", "public") : path.resolve(import.meta.dirname, "public");
  if (!fs.existsSync(distPath)) {
    console.error(
      `Could not find the build directory: ${distPath}, make sure to build the client first`
    );
  }
  const homePath = path.resolve(distPath, "index.html");
  const spaShellPath = path.resolve(distPath, "..", "spa-shell.html");
  const recordPath = path.resolve(distPath, "..", "record.html");
  app.get("/", (_req, res) => {
    res.sendFile(homePath);
  });
  app.get(["/record", "/record/"], (_req, res) => {
    res.setHeader("Cache-Control", "no-cache");
    res.sendFile(recordPath);
  });
  app.use(express.static(distPath, { index: false }));
  app.use("*", (_req, res) => {
    res.sendFile(spaShellPath);
  });
}

// server/_core/index.ts
function isPortAvailable(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.listen(port, () => {
      server.close(() => resolve(true));
    });
    server.on("error", () => resolve(false));
  });
}
async function findAvailablePort(startPort = 3e3) {
  for (let port = startPort; port < startPort + 20; port++) {
    if (await isPortAvailable(port)) {
      return port;
    }
  }
  throw new Error(`No available port found starting from ${startPort}`);
}
function msUntilNextSettlementTime() {
  const now = /* @__PURE__ */ new Date();
  const todayUTC7 = new Date(now);
  todayUTC7.setUTCHours(7, 0, 0, 0);
  if (now.getTime() < todayUTC7.getTime()) {
    return todayUTC7.getTime() - now.getTime();
  } else {
    todayUTC7.setUTCDate(todayUTC7.getUTCDate() + 1);
    return todayUTC7.getTime() - now.getTime();
  }
}
function scheduleDailySettlement() {
  const ms = msUntilNextSettlementTime();
  const hours = Math.round(ms / 1e3 / 60 / 60 * 10) / 10;
  console.log(`[Settlement] Next auto-settlement scheduled in ${hours} hours`);
  setTimeout(async () => {
    console.log("[Settlement] Running scheduled auto-settlement...");
    try {
      const result = await autoSettlePicks();
      console.log(`[Settlement] Scheduled result: ${result.message}`);
    } catch (error) {
      console.error("[Settlement] Scheduled settlement failed:", error);
    }
    scheduleDailySettlement();
  }, ms);
}
async function startServer() {
  const app = express2();
  const server = createServer(app);
  app.use(express2.json({ limit: "50mb" }));
  app.use(express2.urlencoded({ limit: "50mb", extended: true }));
  registerAdminAuthRoutes(app);
  app.use(
    "/api/trpc",
    createExpressMiddleware({
      router: appRouter,
      createContext
    })
  );
  if (process.env.NODE_ENV === "development") {
    const { setupVite } = await import("./vite");
    await setupVite(app, server);
  } else {
    serveStatic(app);
  }
  const preferredPort = parseInt(process.env.PORT || "3000");
  const port = await findAvailablePort(preferredPort);
  if (port !== preferredPort) {
    console.log(`Port ${preferredPort} is busy, using port ${port} instead`);
  }
  server.listen(port, () => {
    console.log(`Server running on http://localhost:${port}/`);
  });
  scheduleDailySettlement();
}
startServer().catch(console.error);
