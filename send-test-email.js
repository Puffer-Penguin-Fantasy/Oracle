require("dotenv").config();
const { Resend } = require('resend');

async function sendTestEmail() {
  const { RESEND_API_KEY, EMAIL_TO } = process.env;

  if (!RESEND_API_KEY || !EMAIL_TO) {
    let missing = [];
    if (!RESEND_API_KEY) missing.push("RESEND_API_KEY");
    if (!EMAIL_TO) missing.push("EMAIL_TO");
    console.error(`❌ Test failed: Missing environment variables (${missing.join(", ")})`);
    return;
  }

  console.log("📨 Attempting to send test email via Resend...");
  console.log(`   To: ${EMAIL_TO}`);

  const resend = new Resend(RESEND_API_KEY);

  try {
    const { data, error } = await resend.emails.send({
      from: 'Puffer Test <onboarding@resend.dev>',
      to: EMAIL_TO,
      subject: "🧪 Puffer Oracle: Resend Test Notification",
      text: "This is a test email via Resend. If you received this, your configuration is now perfect!",
      html: "<h2>🧪 Puffer Oracle Test</h2><p>Your Resend configuration is working perfectly.</p><p><b>Status:</b> ✅ System Online</p>",
    });

    if (error) throw error;

    console.log("✅ Test email sent successfully via Resend!");
    console.log("   ID:", data.id);
  } catch (err) {
    console.error("❌ Failed to send test email:", err.message);
  }
}

sendTestEmail();

