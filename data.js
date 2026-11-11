// DIWAY - API única (Vercel Serverless Function) com banco Upstash Redis.
// Variáveis de ambiente:
//  - UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN (ou KV_REST_API_URL / KV_REST_API_TOKEN) -> criadas pela integração Upstash
//  - ADMIN_PASSWORD -> senha do painel (se não definir, usa 1123)
const crypto = require("crypto");
const URL_ = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
const TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
const ADMIN = String(process.env.ADMIN_PASSWORD || "1123");

const fail = (status, message) => Object.assign(new Error(message), { status });
const str = (v, max) => String(v == null ? "" : v).slice(0, max);
const final = (p) => +(p.price * (1 - (p.disc || 0) / 100)).toFixed(2);
const ipOf = (req) => (String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || "x").slice(0, 60);

async function redis(cmd) {
  const r = await fetch(URL_, { method: "POST", headers: { Authorization: "Bearer " + TOKEN }, body: JSON.stringify(cmd) });
  const j = await r.json();
  if (j.error) throw new Error(j.error);
  return j.result;
}
const getJ = async (k) => { const v = await redis(["GET", k]); return v ? JSON.parse(v) : null; };
const setJ = (k, v) => redis(["SET", k, JSON.stringify(v)]);

const mk = (id, name, price, disc, seats) => ({
  id, name, price, disc, seats, cat: "FiveM", img: "", qr: "",
  pix: "00020126DEMO-DIWAY-" + name.toUpperCase().replace(/\W+/g, "") + "-TROQUE-PELA-SUA-CHAVE-PIX"
});
const SEED = [mk("p1", "Plano Basic", 50, 0, 1), mk("p2", "Plano Advanced", 200, 25, 1), mk("p3", "Plano Private", 300, 17, 1),
  mk("p4", "Plano Slotted", 400, 13, 1), mk("p5", "Plano Exclusive", 750, 20, 1), mk("p6", "Plano Squad", 600, 10, 5)];

function validCPF(v) {
  v = String(v).replace(/\D/g, "");
  if (v.length !== 11 || /^(\d)\1+$/.test(v)) return false;
  for (let t = 9; t < 11; t++) { let s = 0; for (let i = 0; i < t; i++) s += v[i] * (t + 1 - i); if ((s * 10) % 11 % 10 != v[t]) return false; }
  return true;
}
function cleanProducts(arr) {
  if (!Array.isArray(arr) || arr.length > 100) throw fail(400, "Lista de produtos inválida");
  return arr.map((p) => {
    const price = Number(p.price);
    if (!p.id || !p.name || !(price >= 0)) throw fail(400, "Produto inválido");
    return { id: str(p.id, 40), name: str(p.name, 120), price, disc: Math.min(100, Math.max(0, Number(p.disc) || 0)),
      seats: Math.min(20, Math.max(1, parseInt(p.seats) || 1)), cat: "FiveM",
      img: str(p.img, 300000), qr: str(p.qr, 300000), pix: str(p.pix, 2000) };
  });
}
async function auth(req, pass) {
  const key = "rl:" + ipOf(req);
  if (Number((await redis(["GET", key])) || 0) >= 10) throw fail(429, "Muitas tentativas. Aguarde 1 minuto.");
  const a = crypto.createHash("sha256").update(String(pass || "")).digest();
  const b = crypto.createHash("sha256").update(ADMIN).digest();
  if (!crypto.timingSafeEqual(a, b)) {
    if ((await redis(["INCR", key])) === 1) await redis(["EXPIRE", key, 60]);
    throw fail(401, "Senha incorreta");
  }
}

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") return res.status(405).json({ error: "Método não permitido" });
  if (!URL_ || !TOKEN) return res.status(500).json({ error: "Banco de dados não configurado (integração Upstash)" });
  const b = req.body && typeof req.body === "object" ? req.body : {};
  try {
    if (b.action === "public") {
      return res.status(200).json({ products: (await getJ("products")) || SEED, video: (await getJ("video")) || "" });
    }
    if (b.action === "order") {
      const k = "ro:" + ipOf(req);
      const n = await redis(["INCR", k]);
      if (n === 1) await redis(["EXPIRE", k, 3600]);
      if (n > 20) throw fail(429, "Muitos pedidos em pouco tempo. Tente mais tarde.");
      const p = ((await getJ("products")) || SEED).find((x) => x.id === b.pid);
      if (!p) throw fail(400, "Produto não encontrado");
      const name = str(b.name, 100).trim(), cpf = str(b.cpf, 14);
      if (name.split(/\s+/).length < 2) throw fail(400, "Informe nome e sobrenome");
      if (!validCPF(cpf)) throw fail(400, "CPF inválido");
      const ds = Array.isArray(b.discords) ? b.discords.map((x) => String(x).trim()) : [];
      const seats = p.seats || 1;
      if (ds.length !== seats || ds.some((x) => !/^\d{17,20}$/.test(x)) || new Set(ds).size !== ds.length) throw fail(400, "IDs do Discord inválidos");
      const o = { id: "DW" + Date.now().toString(36).toUpperCase() + crypto.randomBytes(2).toString("hex").toUpperCase(),
        date: new Date().toISOString(), name, cpf, discord: ds.join(", "), discords: ds, pid: p.id, pname: p.name, seats,
        value: final(p), status: "Aguardando Pix" };
      await redis(["HSET", "orders", o.id, JSON.stringify(o)]);
      return res.status(200).json({ order: { id: o.id, seats } });
    }
    // ----- a partir daqui: somente admin -----
    await auth(req, b.pass);
    if (b.action === "login") return res.status(200).json({ ok: true });
    if (b.action === "orders") {
      const flat = (await redis(["HGETALL", "orders"])) || [];
      const list = [];
      for (let i = 1; i < flat.length; i += 2) list.push(JSON.parse(flat[i]));
      list.sort((x, y) => (x.date < y.date ? 1 : -1));
      return res.status(200).json({ orders: list });
    }
    if (b.action === "confirm") {
      const v = await redis(["HGET", "orders", str(b.id, 40)]);
      if (!v) throw fail(404, "Pedido não encontrado");
      const o = JSON.parse(v); o.status = "Pago / Entregue";
      await redis(["HSET", "orders", o.id, JSON.stringify(o)]);
      return res.status(200).json({ ok: true });
    }
    if (b.action === "delOrder") { await redis(["HDEL", "orders", str(b.id, 40)]); return res.status(200).json({ ok: true }); }
    if (b.action === "setProducts") { await setJ("products", cleanProducts(b.products)); return res.status(200).json({ ok: true }); }
    if (b.action === "setVideo") {
      const v = str(b.video, 500).trim();
      if (v && !/^https:\/\//.test(v)) throw fail(400, "Use um link começando com https://");
      await setJ("video", v);
      return res.status(200).json({ ok: true });
    }
    throw fail(400, "Ação inválida");
  } catch (e) {
    res.status(e.status || 500).json({ error: e.status ? e.message : "Erro interno do servidor" });
  }
};
