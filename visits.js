// functions/api/visits.js  — Cloudflare Pages Function
// POST /api/visits  : يسجّل زيارة (أي زائر، من غير أي تسجيل) بالدولة والمدينة من Cloudflare نفسه
// GET  /api/visits  : إحصائيات الزيارات — للإدارة فقط (هيدر x-admin-key)
// المطلوب في Cloudflare (مرة واحدة):
//   1) KV namespace واربطه بالمشروع باسم  VISITS
//   2) متغير سري (Secret) باسم  ADMIN_KEY  = أي كلمة طويلة تختارها
// لا يتم تخزين الـ IP ولا أي بيانات شخصية.

const json = (o, s = 200) =>
  new Response(JSON.stringify(o), {
    status: s,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });

const safeEq = (a, b) => {
  a = String(a || ""); b = String(b || "");
  if (a.length !== b.length || !b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
};

export function aggregate(items, now, tzMin) {
  const off = (+tzMin || 0) * 60000;
  const day = (t) => new Date(t - off).toISOString().slice(0, 10);
  const today = day(now);
  const daily = {};
  for (let i = 13; i >= 0; i--) daily[day(now - i * 864e5)] = 0;
  const co = {}, ci = {}, dev = new Set();
  let t7 = 0, tod = 0;
  for (const v of items) {
    const dk = day(v.t);
    if (dk in daily) daily[dk]++;
    if (dk === today) tod++;
    if (v.t >= now - 7 * 864e5) t7++;
    if (v.d) dev.add(v.d);
    const ck = v.c || "";
    co[ck] = (co[ck] || 0) + 1;
    if (v.ci || v.c) {
      const k = [v.ci, v.c].filter(Boolean).join(", ");
      const e = ci[k] || (ci[k] = { k, n: 0, la: v.la || "", lo: v.lo || "" });
      e.n++;
    }
  }
  const top = (o) => Object.values(o).sort((a, b) => b.n - a.n);
  return {
    ok: true,
    total: items.length,
    today: tod,
    last7: t7,
    unique: dev.size,
    daily: Object.entries(daily).map(([d, n]) => ({ d, n })),
    countries: Object.entries(co).map(([k, n]) => ({ k, n })).sort((a, b) => b.n - a.n),
    cities: top(ci),
    recent: items.slice().sort((a, b) => b.t - a.t).slice(0, 30).map((v) => ({ t: v.t, c: v.c, ci: v.ci, m: v.m })),
  };
}

export async function onRequestPost({ request, env }) {
  if (!env.VISITS) return json({ ok: false, why: "no-kv" }, 503);
  const ua = request.headers.get("user-agent") || "";
  if (/bot|crawl|spider|preview|monitor|headless/i.test(ua)) return json({ ok: true, skip: 1 });
  let b = {};
  try { b = JSON.parse(await request.text()); } catch (e) {}
  const cf = request.cf || {};
  const now = Date.now();
  const rec = {
    t: now,
    d: String(b.d || "").replace(/[^\w-]/g, "").slice(0, 40),
    c: String(cf.country || "").slice(0, 2),
    ci: String(cf.city || "").slice(0, 40),
    la: cf.latitude ? String(cf.latitude).slice(0, 10) : "",
    lo: cf.longitude ? String(cf.longitude).slice(0, 10) : "",
    m: /mobile|android|iphone|ipad/i.test(ua) ? "m" : "d",
  };
  const key = "v:" + String(now).padStart(15, "0") + ":" + Math.random().toString(36).slice(2, 7);
  try {
    await env.VISITS.put(key, "1", { expirationTtl: 60 * 60 * 24 * 180, metadata: rec });
  } catch (e) {}
  return json({ ok: true });
}

export async function onRequestGet({ request, env }) {
  if (!env.ADMIN_KEY || !safeEq(request.headers.get("x-admin-key"), env.ADMIN_KEY)) return json({ ok: false }, 401);
  if (!env.VISITS) return json({ ok: false, why: "no-kv" }, 503);
  const tz = new URL(request.url).searchParams.get("tz");
  const items = [];
  let cursor;
  for (let i = 0; i < 30; i++) {
    const r = await env.VISITS.list({ prefix: "v:", limit: 1000, cursor });
    for (const k of r.keys) if (k.metadata) items.push(k.metadata);
    if (r.list_complete) break;
    cursor = r.cursor;
  }
  return json(aggregate(items, Date.now(), tz));
}
