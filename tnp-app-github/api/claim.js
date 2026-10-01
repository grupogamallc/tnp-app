/* POST /api/claim   Body: { sid }
   Devuelve: { url } — la liga de entrada a la app.

   Por que existe: Stripe regresa al comprador a la app en el MISMO instante en
   que dispara el webhook. Si gana el comprador, su cuenta todavia no existe y
   veria un error justo despues de pagar. Esta funcion hace el mismo trabajo por
   su cuenta. Las dos rutas son idempotentes, asi que no importa cual llegue primero.

   El identificador de sesion viene del navegador, o sea que NO se le cree: se
   consulta contra Stripe y se exige que este pagada. */
const L = require("./_lib");

module.exports = async (req, res) => {
  if (L.cors(req, res)) return;
  if (req.method !== "POST") { res.status(405).json({ error: "metodo" }); return; }

  try {
    const sid = String((req.body && req.body.sid) || "").trim();
    if (!/^cs_[A-Za-z0-9_]{10,200}$/.test(sid)) { res.status(400).json({ error: "sid" }); return; }

    const sesion = await L.stripe("/checkout/sessions/" + sid);
    const pagada = sesion.payment_status === "paid" || sesion.status === "complete";
    if (!pagada) { res.status(402).json({ error: "no_pagada", mensaje: "Ese pago todavía no se confirma." }); return; }

    const r = await L.activarCompra({ sesion });
    const liga = await L.ligaDeEntrada(r.correo, "magiclink");
    res.status(200).json({ url: liga, correo: r.correo });

  } catch (e) {
    if (e.sinLlave) { res.status(503).json({ error: "sin_configurar" }); return; }
    console.error("claim", e && e.message);
    res.status(500).json({ error: "servidor",
      mensaje: "Tu pago sí entró. Revisa tu correo en unos minutos o escríbenos a info@tunuevoplan.com." });
  }
};
