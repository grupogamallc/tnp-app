/* POST /api/reset   Body: { correo }
   Manda el correo para recuperar la contrasena, con NUESTRA liga y NUESTRO
   diseno. No se usa la liga que arma el proveedor: esa rebota por /auth/v1/verify
   y aterriza donde diga el Site URL del proyecto.

   Siempre responde ok, exista o no la cuenta: si no, esto se vuelve una forma
   de averiguar quien esta registrado. */
const L = require("./_lib");

module.exports = async (req, res) => {
  if (L.cors(req, res)) return;
  if (req.method !== "POST") { res.status(405).json({ error: "metodo" }); return; }

  const correo = String((req.body && req.body.correo) || "").trim().toLowerCase();
  if (!L.correoValido(correo)) { res.status(400).json({ error: "correo", mensaje: "Escribe un correo válido." }); return; }

  try {
    const u = await L.usuarioPorCorreo(correo);
    if (u) {
      const liga = await L.ligaDeEntrada(correo, "recovery");
      await L.correo(correo, "Recupera tu contraseña",
        L.plantilla("Vuelve a entrar.",
          ["Pediste recuperar tu contraseña de Tu Nuevo Plan.",
           "Toca el botón y elige una nueva. Tu plan y tu progreso siguen donde los dejaste."],
          "Elegir una contraseña nueva", liga),
        "Recupera tu contraseña aquí: " + liga);
    }
  } catch (e) {
    console.error("reset", e && e.message);
  }

  res.status(200).json({ ok: true });
};
