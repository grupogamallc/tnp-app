/* POST /api/portal   Cabecera: Authorization: Bearer <jwt de la sesion>
   Devuelve: { url } — el portal de cliente de Stripe.

   Ahi la persona cambia su tarjeta, ve sus facturas y cancela. Cero codigo de
   facturacion propio.

   Ojo al configurar: /v1/billing_portal/sessions devuelve error hasta que se
   guarda la configuracion del portal en el panel de Stripe, una sola vez. El
   mensaje de error no lo dice con esas palabras. */
const L = require("./_lib");

module.exports = async (req, res) => {
  if (L.cors(req, res)) return;
  if (req.method !== "POST") { res.status(405).json({ error: "metodo" }); return; }

  try {
    const auth = req.headers.authorization || "";
    const jwt = auth.startsWith("Bearer ") ? auth.slice(7) : null;
    if (!jwt) { res.status(401).json({ error: "sin_sesion" }); return; }

    /* La identidad se valida contra Supabase, no se confia en lo que manden. */
    const r = await fetch(L.SB_URL + "/auth/v1/user", {
      headers: { apikey: process.env.SUPABASE_SERVICE_ROLE_KEY, authorization: "Bearer " + jwt },
    });
    if (!r.ok) { res.status(401).json({ error: "sesion_invalida" }); return; }
    const u = await r.json();
    if (!u || !u.id) { res.status(401).json({ error: "sesion_invalida" }); return; }

    const m = L.unaFila(await L.dbSel("membresias",
      "select=stripe_customer&perfil_id=eq." + u.id + "&limit=1"));
    if (!m || !m.stripe_customer) {
      res.status(404).json({ error: "sin_suscripcion",
        mensaje: "Todavía no tienes una suscripción activa." });
      return;
    }

    const s = await L.stripe("/billing_portal/sessions", {
      customer: m.stripe_customer,
      return_url: L.APP_URL + "/",
    });
    res.status(200).json({ url: s.url });

  } catch (e) {
    if (e.sinLlave) { res.status(503).json({ error: "sin_configurar" }); return; }
    console.error("portal", e && e.message);
    res.status(500).json({ error: "servidor", mensaje: "No se pudo abrir tu suscripción." });
  }
};
