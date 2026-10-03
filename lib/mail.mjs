import nodemailer from 'nodemailer';

export function createMailer(env, createTransport = nodemailer.createTransport) {
  if (env.GMAIL_USER || env.GMAIL_APP_PASSWORD) {
    const user = env.GMAIL_USER?.trim();
    const password = env.GMAIL_APP_PASSWORD?.replace(/\s/g, '');
    if (!user || !password) throw new Error('Gmail delivery requires GMAIL_USER and GMAIL_APP_PASSWORD.');
    const transport = createTransport({
      service: 'gmail',
      auth: {user, pass: password},
      connectionTimeout: 10000,
      greetingTimeout: 10000,
      socketTimeout: 10000
    });
    return {preview: false, async send({to, subject, text, replyTo}) {
      try {
        await transport.sendMail({from: `JJ TrendZ <${user}>`, to, subject, text, ...(replyTo ? {replyTo} : {})});
      } catch (error) {
        console.error('JJ TrendZ Gmail delivery failed', {code: error.code, responseCode: error.responseCode});
        throw Object.assign(new Error('Email delivery is temporarily unavailable.'), {status: 503});
      }
    }};
  }
  return {preview:false, async send({to,subject,text,replyTo}) {
    let response;
    try {
      response=await fetch('https://api.resend.com/emails',{method:'POST',headers:{Authorization:`Bearer ${env.RESEND_API_KEY}`,'Content-Type':'application/json'},body:JSON.stringify({from:env.EMAIL_FROM,to:[to],subject,text,...(replyTo?{reply_to:replyTo}:{})}),signal:AbortSignal.timeout(10000)});
    } catch { throw Object.assign(new Error('Email delivery is temporarily unavailable.'),{status:503}); }
    if(!response.ok) throw Object.assign(new Error('Email delivery is temporarily unavailable.'),{status:503});
  }};
}
