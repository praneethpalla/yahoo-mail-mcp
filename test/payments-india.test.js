// Offline tests for the India-specific payment red flags (same checks as mail-brief-mcp).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { paymentWarnings } from '../safety.js';

const flags = (text) => (paymentWarnings(text)[0] || '');

test('India-specific scam patterns are flagged', () => {
    const cases = {
        'Pay the pending ₹4,999 to refund.desk@okaxis to avoid KYC suspension': [/a UPI ID/, /KYC\/PAN\/Aadhaar/],
        'Send money to my UPI ID and I will confirm': [/pay to a UPI ID/],
        'Our bank changed — transfer to A/C 1234567890, IFSC HDFC0001234': [/bank account number/, /IFSC code/],
        'URGENT: pay Rs. 12,500 today or your account will be blocked': [/urgent pressure to pay/],
        'Your account will be frozen. Clear INR 2,300 immediately.': [/urgent pressure to pay/],
        'Kindly do an RTGS to the new account below': [/NEFT\/RTGS\/IMPS transfer request/],
        'Please share the OTP to complete verification': [/OTP, UPI PIN, or CVV/],
        'Reply with your UPI PIN to receive the refund': [/OTP, UPI PIN, or CVV/],
        'Update your KYC within 24 hours or your account will be suspended': [/KYC\/PAN\/Aadhaar/],
        'Your Aadhaar verification is pending, click here': [/KYC\/PAN\/Aadhaar/],
        'Your electricity will be disconnected tonight. Call now.': [/disconnection threat/],
        'Your parcel is held. Pay customs charges to release it.': [/courier or customs fee/]
    };
    for (const [text, expected] of Object.entries(cases)) {
        const warning = flags(text);
        for (const re of expected) assert.match(warning, re, text);
        assert.match(warning, /Verify any payment request through a contact you already trust/);
    }
});

test('routine Indian bank and fund emails do not trigger warnings', () => {
    for (const text of [
        'Your SIP of ₹3,000 is due on Oct 5.',
        'NEFT credit of Rs 25,000 received in your account.',
        'IMPS transfer of INR 1,000 to Ravi was successful.',
        'Never share your OTP with anyone. Bank staff will never ask for it.',
        'Do not share your UPI PIN or CVV with anyone.',
        'Your PAN is linked successfully.',
        'Link your Aadhaar with PAN before the deadline in the newsletter.',
        'Contact us at support@sbi.co.in for help.',
        'Your statement for September 2026 is ready. Total: ₹45,210.50',
        'Funds crossed a billion dollars.'
    ]) {
        assert.equal(flags(text), '', text);
    }
});

test('the original (non-India) patterns still work', () => {
    assert.match(flags('Our bank details have changed. Please pay to our new account.'), /change of bank or payment details/);
    assert.match(flags('Please remit to IBAN GB82 WEST 1234 5698 7654 32 today.'), /an IBAN/);
    assert.match(flags('I need you to buy 5 Apple gift cards for a client.'), /gift cards/);
});
