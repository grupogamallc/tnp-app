/* POST /api/prospecto   Body: { correo, nombre, programa, plan, kcal, prot, quiz, origen }

   Guarda a quien termino el cuestionario y le manda sus numeros por correo.
   Esto es lo unico que quedaba sin capturar: antes, quien contestaba y no
   compraba se perdia para siempre.

   Dos cuidados:
   - La tabla no tiene politicas: se escribe aqui con service_role, no desde el
     navegador. Asi la lista no se puede leer ni llenar de basura desde fuera.
   - El envio va topado a uno por correo por hora. Sin ese tope, este endpoint
     es publico y sirve de canon de spam contra cualquier direccion.

   Siempre responde 200 salvo que el correo venga mal: si falla el guardado o el
   envio, el usuario no tiene por que quedarse trabado en su cuestionario. */
const L = require("./_lib");

const TOPE_MS = 60 * 60 * 1000;

const corta = (v, n) => { const s = v == null ? null : String(v).trim(); return s ? s.slice(0, n) : null; };
const entre = (v, min, max) => { const n = Math.round(Number(v)); return Number.isFinite(n) && n >= min && n <= max ? n : null; };

function cuerpoCorreo(d) {
  const filas = [
    [d.kcal ? d.kcal.toLocaleString("en-US") : null, "kcal al día"],
    [d.prot ? d.prot + " g" : null, "proteína al día"],
  ].filter(f => f[0]);

  const nums = filas.length ? `
<table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 22px"><tr>
${filas.map(f => `<td align="center" style="padding:16px 22px;background:#F2F4F8;border-radius:14px">
<div style="font-size:26px;font-weight:800;color:#1E3A8A;line-height:1">${f[0]}</div>
<div style="font-size:11px;color:#6B7280;margin-top:4px">${f[1]}</div></td><td style="width:10px"></td>`).join("")}
</tr></table>` : "";

  const hola = d.nombre ? `Hola ${d.nombre},` : "Hola,";

  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"></head>
<body style="margin:0;padding:0;background:#F2F4F8">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F2F4F8;padding:28px 14px">
<tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#fff;border-radius:16px;padding:32px 28px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">
<tr><td>
<p style="margin:0 0 6px;font-size:11px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:#E94B3C">Tu Nuevo Plan</p>
<h1 style="margin:0 0 18px;font-size:25px;line-height:1.2;color:#111827;font-weight:800">Estos son tus números.</h1>
<p style="margin:0 0 14px;font-size:15px;line-height:1.6;color:#374151">${hola} aquí te los dejamos por escrito para que no se te pierdan.</p>
${nums}
${d.programa ? `<p style="margin:0 0 14px;font-size:15px;line-height:1.6;color:#374151">Tu programa: <b style="color:#111827">${d.programa}</b>. Tu menú de la semana ya está generado con comida real, ajustado a lo que nos contaste.</p>` : ""}
<p style="margin:0 0 14px;font-size:15px;line-height:1.6;color:#374151">Son un punto de partida, no una regla: se ajustan contigo conforme avanzas.</p>
<table role="presentation" cellpadding="0" cellspacing="0" style="margin:22px 0"><tr>
<td align="center" bgcolor="#E94B3C" style="border-radius:999px">
<a href="${L.APP_URL}" style="display:block;padding:15px 30px;color:#ffffff;font-size:15px;font-weight:700;text-decoration:none">Abrir mi plan</a>
</td></tr></table>
<p style="margin:0 0 20px;font-size:12px;color:#1E3A8A;word-break:break-all">${L.APP_URL}</p>
<p style="margin:0;font-size:12px;line-height:1.6;color:#9CA3AF">Te escribimos porque dejaste tu correo en el cuestionario. Te avisamos cuando abra tu programa. Si no quieres saber más de nosotros, responde BAJA a este correo y te quitamos de la lista.</p>
<p style="margin:14px 0 0;font-size:11px;line-height:1.6;color:#9CA3AF">Tu Nuevo Plan es acompañamiento nutricional. No diagnostica, trata ni cura ninguna enfermedad, y no sustituye la atención de tu médico.</p>
</td></tr></table>
<p style="margin:16px 0 0;font-size:11px;color:#9CA3AF;font-family:-apple-system,sans-serif">Tu Nuevo Plan &middot; tunuevoplan.com</p>
</td></tr></table></body></html>`;
}

function textoCorreo(d) {
  const l = ["Estos son tus números."];
  if (d.kcal) l.push(d.kcal + " kcal al día");
  if (d.prot) l.push(d.prot + " g de proteína al día");
  if (d.programa) l.push("Programa: " + d.programa);
  l.push("Abre tu plan aquí: " + L.APP_URL);
  l.push("Si no quieres saber más de nosotros, responde BAJA a este correo.");
  return l.join("\n");
}

module.exports = async (req, res) => {
  if (L.cors(req, res)) return;
  if (req.method !== "POST") { res.status(405).json({ error: "metodo" }); return; }

  const b = req.body || {};
  const correo = String(b.correo || "").trim().toLowerCase();
  if (!L.correoValido(correo)) { res.status(400).json({ error: "correo", mensaje: "Escribe un correo válido." }); return; }

  let quiz = (b.quiz && typeof b.quiz === "object" && !Array.isArray(b.quiz)) ? b.quiz : null;
  if (quiz && JSON.stringify(quiz).length > 8000) quiz = null;

  const d = {
    correo,
    nombre: corta(b.nombre, 80),
    programa: corta(b.programa, 40),
    plan: corta(b.plan, 40),
    kcal: entre(b.kcal, 500, 10000),
    prot: entre(b.prot, 20, 500),
    quiz,
    origen: corta(b.origen, 40) || "cuestionario",
  };

  /* Se lee lo que ya habia ANTES de escribir, por dos razones: para saber si
     ya se le mando correo hace poco, y para arrastrar ultimo_envio dentro del
     upsert. Si no se arrastra, el upsert lo deja en null y el tope se cae. */
  let previo = null;
  try {
    previo = L.unaFila(await L.dbSel("prospectos",
      "select=id,ultimo_envio&limit=1&correo=eq." + encodeURIComponent(correo)));
  } catch (e) { console.error("prospecto leer", e && e.message); }

  const ultimo = (previo && previo.ultimo_envio) ? Date.parse(previo.ultimo_envio) : 0;
  const toca = !(ultimo && (Date.now() - ultimo) < TOPE_MS);
  const ahora = new Date().toISOString();

  try {
    await L.dbUps("prospectos", [{
      ...d,
      actualizado: ahora,
      ultimo_envio: toca ? ahora : new Date(ultimo).toISOString(),
    }], "correo");
  } catch (e) {
    console.error("prospecto guardar", e && e.message);
    res.status(200).json({ ok: true, guardado: false });
    return;
  }

  if (!toca) { res.status(200).json({ ok: true, enviado: false }); return; }

  /* ultimo_envio ya quedo marcado arriba a proposito: si Resend se tarda o
     truena, preferimos no mandarle nada a que le lleguen diez correos. */
  try {
    await L.correo(correo, "Estos son tus números · Tu Nuevo Plan", cuerpoCorreo(d), textoCorreo(d));
  } catch (e) {
    console.error("prospecto correo", e && e.message);
    res.status(200).json({ ok: true, enviado: false });
    return;
  }

  res.status(200).json({ ok: true, enviado: true });
};
