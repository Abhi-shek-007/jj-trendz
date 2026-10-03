import test from 'node:test';
import assert from 'node:assert/strict';
import {createMailer} from '../lib/mail.mjs';
import {validateConfig} from '../lib/security.mjs';

const base = {
  DATABASE_URL: 'postgres://test', OWNER_EMAIL: 'owner@gmail.com',
  OWNER_PASSWORD: 'test-owner-password-123', OTP_SECRET: 'test-secret-'.repeat(4),
  CRON_SECRET: 'cron-secret-'.repeat(4), APP_ORIGIN: 'https://shop.test'
};

test('Gmail configuration sends OTPs through Nodemailer with the Gmail sender', async () => {
  const env = {...base, GMAIL_USER: 'jjtrends@gmail.com', GMAIL_APP_PASSWORD: 'abcd efgh ijkl mnop'};
  assert.doesNotThrow(() => validateConfig(env));
  let options, message;
  const mailer = createMailer(env, config => {
    options = config;
    return {sendMail: async mail => {message = mail; return {messageId: 'test-message'};}};
  });
  await mailer.send({to: 'customer@gmail.com', subject: 'Your code', text: 'Code: 123456', replyTo: 'owner@gmail.com'});
  assert.equal(options.service, 'gmail');
  assert.deepEqual(options.auth, {user: 'jjtrends@gmail.com', pass: 'abcdefghijklmnop'});
  assert.deepEqual(message, {
    from: 'JJ TrendZ <jjtrends@gmail.com>', to: 'customer@gmail.com',
    subject: 'Your code', text: 'Code: 123456', replyTo: 'owner@gmail.com'
  });
});

test('incomplete Gmail settings fail instead of silently using Resend', async () => {
  const env = {...base, GMAIL_USER: 'jjtrends@gmail.com', RESEND_API_KEY: 'key', EMAIL_FROM: 'JJ <shop@example.test>'};
  assert.throws(() => validateConfig(env), /GMAIL_USER and GMAIL_APP_PASSWORD/);
  assert.throws(() => createMailer(env), /GMAIL_USER and GMAIL_APP_PASSWORD/);
  assert.throws(() => validateConfig(base), /Gmail or Resend/);
});

test('Gmail delivery failure is reported to the OTP flow', async () => {
  const env = {...base, GMAIL_USER: 'jjtrends@gmail.com', GMAIL_APP_PASSWORD: 'abcdefghijklmnop'};
  const mailer = createMailer(env, () => ({sendMail: async () => {throw new Error('SMTP authentication failed');}}));
  await assert.rejects(mailer.send({to: 'customer@gmail.com', subject: 'Your code', text: 'Code: 123456'}), error => error.status === 503);
});
