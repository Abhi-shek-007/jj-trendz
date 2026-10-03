export function createMailer(env) {
  return {preview:false, async send({to,subject,text,replyTo}) {
    let response;
    try {
      response=await fetch('https://api.resend.com/emails',{method:'POST',headers:{Authorization:`Bearer ${env.RESEND_API_KEY}`,'Content-Type':'application/json'},body:JSON.stringify({from:env.EMAIL_FROM,to:[to],subject,text,...(replyTo?{reply_to:replyTo}:{})}),signal:AbortSignal.timeout(10000)});
    } catch { throw Object.assign(new Error('Email delivery is temporarily unavailable.'),{status:503}); }
    if(!response.ok) throw Object.assign(new Error('Email delivery is temporarily unavailable.'),{status:503});
  }};
}
