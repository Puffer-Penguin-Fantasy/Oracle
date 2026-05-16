require("dotenv").config();
const nodemailer = require("nodemailer");

async function sendTestEmail() {
  const { EMAIL_USER, EMAIL_PASS, EMAIL_TO } = process.env;

  if (!EMAIL_USER || !EMAIL_PASS || !EMAIL_TO) {
    let missing = [];
    if (!EMAIL_USER) missing.push("EMAIL_USER");
    if (!EMAIL_PASS) missing.push("EMAIL_PASS");
    if (!EMAIL_TO) missing.push("EMAIL_TO");
    console.error(`❌ Test failed: Missing environment variables (${missing.join(", ")})`);
    return;
  }

  console.log("📨 Attempting to send test email...");
  console.log(`   User: ${EMAIL_USER}`);
  console.log(`   To:   ${EMAIL_TO}`);

  const transporter = nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 465,
    secure: true, // Use SSL
    auth: {
      user: EMAIL_USER,
      pass: EMAIL_PASS,
    },
  });



  try {
    const info = await transporter.sendMail({
      from: `"Puffer Test" <${process.env.EMAIL_USER}>`,
      to: process.env.EMAIL_TO,
      subject: "🧪 Puffer Oracle: Test Notification",
      text: "This is a test email to verify your Oracle notification settings. If you received this, everything is working perfectly!",
      html: "<h2>🧪 Puffer Oracle Test</h2><p>This is a test email to verify your Oracle notification settings.</p><p><b>Status:</b> ✅ System Online</p>",
    });

    console.log("✅ Test email sent successfully!");
    console.log("   Message ID:", info.messageId);
  } catch (err) {
    console.error("❌ Failed to send test email:", err.message);
  }
}

sendTestEmail();
