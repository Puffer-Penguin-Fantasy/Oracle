require("dotenv").config();
const nodemailer = require("nodemailer");

async function sendTestEmail() {
  console.log("📨 Attempting to send test email...");
  console.log(`   Host: ${process.env.EMAIL_HOST}`);
  console.log(`   User: ${process.env.EMAIL_USER}`);
  console.log(`   To:   ${process.env.EMAIL_TO}`);

  const transporter = nodemailer.createTransport({
    host: process.env.EMAIL_HOST,
    port: parseInt(process.env.EMAIL_PORT || "587"),
    secure: process.env.EMAIL_SECURE === "true",
    auth: {
      user: process.env.EMAIL_USER,
      pass: process.env.EMAIL_PASS,
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
