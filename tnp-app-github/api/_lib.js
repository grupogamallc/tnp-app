/* TNP · piezas compartidas de las funciones de servidor.
   Vercel ignora los archivos que empiezan con "_", asi que esto no es una ruta.

   Sin librerias: Stripe, Supabase y Resend son HTTPS. Una sola forma de hablar
   con cada uno. Lo que cobra no puede depender de un paquete de fuera.

   Variables que tienen que existir en Vercel (Production Y Preview):
     STRIPE_SECRET_KEY
     STRIPE_WEBHOOK_SECRET
     SUPABASE_SERVICE_ROLE_KEY
     RESEND_API_KEY
     MAIL_FROM          ej: TNP <hola@send.tunuevoplan.com>
     APP_URL            ej: https://app.tunuevoplan.com
     SITIO_URL          ej: https://tunuevoplan.com
*/
const crypto = require("crypto");

const SB_URL = process.env.SUPABASE_URL || "https://juahjgeewcwqjovnlril.supabase.co";
const APP_URL = process.env.APP_URL || "https://app.tunuevoplan.com";
const SITIO_URL = process.env.SITIO_URL || "https://tunuevoplan.com";

/* ---------- CORS: la pagina de venta vive en otro dominio ---------- */
function cors(req, res) {
  const permitidos = [SITIO_URL, "https://www.tunuevoplan.com", APP_URL];
  const origen = req.headers.origin;
  if (permitidos.includes(origen)) res.setHeader("access-control-allow-origin", origen);
  res.setHeader("access-control-allow-methods", "POST, OPTIONS");
  res.setHeader("access-control-allow-headers", "content-type, authorization");
  res.setHeader("cache-control", "no-store");
  if (req.method === "OPTIONS") { res.status(204).end(); return true; }
  return false;
}

/* ---------- Stripe ---------- */
function formEncode(obj, prefijo) {
  const partes = [];
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    const clave = prefijo ? `${prefijo}[${k}]` : k;
    if (typeof v === "object" && !Array.isArray(v)) partes.push(formEncode(v, clave));
    else if (Array.isArray(v)) v.forEach((x, i) => {
      if (typeof x === "object") partes.push(formEncode(x, `${clave}[${i}]`));
      else partes.push(`${encodeURIComponent(`${clave}[${i}]`)}=${encodeURIComponent(x)}`);
    });
    else partes.push(`${encodeURIComponent(clave)}=${encodeURIComponent(v)}`);
  }
  return partes.filter(Boolean).join("&");
}

async function stripe(ruta, cuerpo, metodo) {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) { const e = new Error("falta STRIPE_SECRET_KEY"); e.sinLlave = true; throw e; }
  const r = await fetch("https://api.stripe.com/v1" + ruta, {
    method: metodo || (cuerpo ? "POST" : "GET"),
    headers: {
      authorization: "Bearer " + key,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: cuerpo ? formEncode(cuerpo) : undefined,
  });
  const b = await r.json().catch(() => null);
  if (!r.ok) {
    const e = new Error((b && b.error && b.error.message) || ("stripe " + r.status));
    e.stripe = b && b.error; e.status = r.status;
    throw e;
  }
  return b;
}

async function buscarCliente(correo) {
  const r = await stripe("/customers?email=" + encodeURIComponent(correo) + "&limit=1");
  return (r.data && r.data[0]) || null;
}

/* La firma del webhook, sin SDK: HMAC-SHA256 de "{t}.{cuerpo crudo}".
   Rechaza lo que tenga mas de 300 segundos (anti repeticion) y compara en
   tiempo constante. Tiene que recibir el cuerpo CRUDO, antes de cualquier parseo. */
function verificarFirma(crudo, cabecera, secreto, tolerancia) {
  if (!crudo || !cabecera || !secreto) return false;
  let t = null; const firmas = [];
  for (const parte of String(cabecera).split(",")) {
    const [k, v] = parte.split("=");
    if (k === "t") t = v;
    if (k === "v1") firmas.push(v);
  }
  if (!t || !firmas.length) return false;
  const edad = Math.abs(Math.floor(Date.now() / 1000) - Number(t));
  if (!Number.isFinite(edad) || edad > (tolerancia || 300)) return false;
  const esperada = crypto.createHmac("sha256", secreto).update(`${t}.${crudo}`).digest("hex");
  const a = Buffer.from(esperada, "utf8");
  return firmas.some(f => {
    const b = Buffer.from(String(f), "utf8");
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  });
}

function cuerpoCrudo(req) {
  return new Promise((ok, no) => {
    let d = ""; req.setEncoding("utf8");
    req.on("data", c => { d += c; if (d.length > 1e6) no(new Error("cuerpo demasiado grande")); });
    req.on("end", () => ok(d));
    req.on("error", no);
  });
}

/* ---------- Supabase con la llave de servicio ----------
   Esta llave se brinca RLS. Vive SOLO aqui, nunca en el navegador. */
function llaveServicio() {
  const k = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!k) { const e = new Error("falta SUPABASE_SERVICE_ROLE_KEY"); e.sinLlave = true; throw e; }
  return k;
}

async function db(ruta, opts) {
  const k = llaveServicio();
  const r = await fetch(SB_URL + "/rest/v1" + ruta, {
    ...opts,
    headers: {
      apikey: k, authorization: "Bearer " + k,
      "content-type": "application/json", ...((opts && opts.headers) || {}),
    },
  });
  if (r.status === 204) return null;
  const b = await r.json().catch(() => null);
  if (!r.ok) {
    const e = new Error((b && (b.message || b.hint)) || ("supabase " + r.status));
    e.status = r.status; e.detalle = b;
    throw e;
  }
  return b;
}

const dbSel = (tabla, qs) => db("/" + tabla + "?" + qs, { method: "GET" });
const dbIns = (tabla, filas) => db("/" + tabla, { method: "POST", headers: { Prefer: "return=representation" }, body: JSON.stringify(filas) });
const dbUpd = (tabla, qs, obj) => db("/" + tabla + "?" + qs, { method: "PATCH", headers: { Prefer: "return=representation" }, body: JSON.stringify(obj) });
const dbUps = (tabla, filas, conflicto, ignorar) => db(
  "/" + tabla + (conflicto ? "?on_conflict=" + encodeURIComponent(conflicto) : ""),
  { method: "POST", headers: { Prefer: "return=representation,resolution=" + (ignorar ? "ignore" : "merge") + "-duplicates" }, body: JSON.stringify(filas) }
);
const unaFila = r => (r && r.length) ? r[0] : null;

/* ---------- Auth de Supabase (admin) ---------- */
async function auth(ruta, cuerpo, metodo) {
  const k = llaveServicio();
  const r = await fetch(SB_URL + "/auth/v1" + ruta, {
    method: metodo || (cuerpo ? "POST" : "GET"),
    headers: { apikey: k, authorization: "Bearer " + k, "content-type": "application/json" },
    body: cuerpo ? JSON.stringify(cuerpo) : undefined,
  });
  const b = await r.json().catch(() => null);
  if (!r.ok) {
    const e = new Error((b && (b.msg || b.error_description || b.message)) || ("auth " + r.status));
    e.status = r.status;
    throw e;
  }
  return b;
}

async function usuarioPorCorreo(correo) {
  const r = await auth("/admin/users?filter=" + encodeURIComponent(correo) + "&per_page=1");
  const lista = (r && r.users) || [];
  return lista.find(u => (u.email || "").toLowerCase() === correo.toLowerCase()) || null;
}

/* Crea la cuenta ya confirmada y con contrasena aleatoria.
   La persona elige la suya al entrar con la liga: una liga de un solo uso es una
   entrada, no una cuenta. Sin ese paso entraria una vez y nunca podria volver. */
async function crearUsuario(correo, nombre) {
  return auth("/admin/users", {
    email: correo,
    email_confirm: true,
    password: crypto.randomUUID() + crypto.randomUUID(),
    user_metadata: nombre ? { nombre } : {},
  });
}

/* Nunca se manda la liga que arma el proveedor: rebota por /auth/v1/verify y
   aterriza donde diga el Site URL. Tomamos el token y armamos la nuestra. */
async function ligaDeEntrada(correo, tipo) {
  const r = await auth("/admin/generate_link", { type: tipo || "magiclink", email: correo });
  const th = r && (r.hashed_token || (r.properties && r.properties.hashed_token));
  if (!th) throw new Error("no vino el token");
  return APP_URL + "/?t=" + encodeURIComponent(th) + (tipo === "recovery" ? "&tipo=recovery" : "");
}

/* ---------- Correo (Resend) ---------- */
function plantilla(titulo, parrafos, textoBoton, liga) {
  const cuerpo = parrafos.map(p => `<p style="margin:0 0 14px;font-size:15px;line-height:1.6;color:#374151">${p}</p>`).join("");
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"></head>
<body style="margin:0;padding:0;background:#F2F4F8">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F2F4F8;padding:28px 14px">
<tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#fff;border-radius:16px;padding:32px 28px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">
<tr><td>
<p style="margin:0 0 6px;font-size:11px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:#E94B3C">Tu Nuevo Plan</p>
<h1 style="margin:0 0 18px;font-size:25px;line-height:1.2;color:#111827;font-weight:800">${titulo}</h1>
${cuerpo}
<!-- boton con tabla y color solido: Outlook ignora los degradados -->
<table role="presentation" cellpadding="0" cellspacing="0" style="margin:22px 0"><tr>
<td align="center" bgcolor="#E94B3C" style="border-radius:999px">
<a href="${liga}" style="display:block;padding:15px 30px;color:#ffffff;font-size:15px;font-weight:700;text-decoration:none">${textoBoton}</a>
</td></tr></table>
<p style="margin:0 0 6px;font-size:12px;color:#6B7280">Si el boton no funciona, copia y pega esta direccion:</p>
<p style="margin:0 0 20px;font-size:12px;color:#1E3A8A;word-break:break-all">${liga}</p>
<p style="margin:0;font-size:12px;line-height:1.6;color:#9CA3AF">Esta liga sirve una sola vez. Si no pediste esto, puedes ignorar el correo.</p>
</td></tr></table>
<p style="margin:16px 0 0;font-size:11px;color:#9CA3AF;font-family:-apple-system,sans-serif">Tu Nuevo Plan &middot; tunuevoplan.com</p>
</td></tr></table></body></html>`;
}

async function correo(para, asunto, html, texto) {
  const k = process.env.RESEND_API_KEY;
  if (!k) { const e = new Error("falta RESEND_API_KEY"); e.sinLlave = true; throw e; }
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { authorization: "Bearer " + k, "content-type": "application/json" },
    body: JSON.stringify({
      from: process.env.MAIL_FROM || "TNP <hola@send.tunuevoplan.com>",
      to: [para], subject: asunto, html, text: texto,
    }),
  });
  if (!r.ok) throw new Error("resend " + r.status + " " + (await r.text().catch(() => "")).slice(0, 200));
  return true;
}

const correoValido = m => typeof m === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(m.trim()) && m.length < 200;

/* ---------- Dar de alta una compra: lo usan el webhook y el canje ----------
   Es idempotente a proposito: el webhook y el regreso del comprador se disparan
   al mismo tiempo y no se sabe cual llega primero. */
async function activarCompra({ sesion, suscripcion }) {
  const correoCompra = (sesion.customer_details && sesion.customer_details.email) ||
                       (sesion.metadata && sesion.metadata.correo) || null;
  if (!correoCompra) throw new Error("la sesion no trae correo");

  const productoId = (sesion.metadata && sesion.metadata.producto) || null;
  const prod = productoId ? unaFila(await dbSel("productos", "select=id,tipo&id=eq." + encodeURIComponent(productoId))) : null;
  const nivel = prod ? ({ app: "app", plan: "plan", top: "top" }[prod.tipo] || "plan") : "plan";

  const sub = suscripcion || (sesion.subscription
    ? await stripe("/subscriptions/" + sesion.subscription).catch(() => null) : null);
  const hasta = sub && sub.current_period_end
    ? new Date(sub.current_period_end * 1000).toISOString()
    : new Date(Date.now() + 31 * 864e5).toISOString();

  /* 1. la compra, con stripe_session UNICO: un reintento no duplica */
  await dbUps("compras", [{
    correo: correoCompra.toLowerCase(),
    producto_id: productoId,
    estado: "pagada",
    stripe_customer: sesion.customer || null,
    stripe_session: sesion.id,
    stripe_subscription: sesion.subscription || null,
    monto_cents: sesion.amount_total || null,
    moneda: sesion.currency || "usd",
    inicia: new Date().toISOString(),
    termina: hasta,
    actualizado: new Date().toISOString(),
  }], "stripe_session");

  /* 2. la cuenta: si no existe, se crea. El pago es el registro. */
  let u = await usuarioPorCorreo(correoCompra);
  let nueva = false;
  if (!u) {
    const nombre = (sesion.customer_details && sesion.customer_details.name) || null;
    u = await crearUsuario(correoCompra, nombre);
    nueva = true;
  }
  const uid = u.id;

  /* 3. el permiso. Esto SOLO lo puede escribir la llave de servicio. */
  await dbUps("membresias", [{
    perfil_id: uid, nivel, estado: "activa", acceso_hasta: hasta,
    stripe_customer: sesion.customer || null,
    stripe_subscription: sesion.subscription || null,
    actualizado: new Date().toISOString(),
  }], "perfil_id");

  /* 4. amarrar la compra a la cuenta */
  await dbUpd("compras", "stripe_session=eq." + encodeURIComponent(sesion.id), { perfil_id: uid })
    .catch(() => {});

  return { uid, correo: correoCompra, nueva, nivel, hasta };
}

module.exports = {
  SB_URL, APP_URL, SITIO_URL,
  cors, stripe, buscarCliente, verificarFirma, cuerpoCrudo,
  db, dbSel, dbIns, dbUpd, dbUps, unaFila,
  auth, usuarioPorCorreo, crearUsuario, ligaDeEntrada,
  plantilla, correo, correoValido, activarCompra,
};
