const bcrypt = require("bcryptjs");
const crypto = require("crypto");

const SALT_ROUNDS = 10;

// A fixed hash to compare against for unknown usernames, so login timing
// doesn't reveal whether an account exists. Generated once, arbitrary.
const DUMMY_HASH = "$2a$10$C6UzMDM.H6dfI/f/IKcEeO6XZ0jL5OhJKb2WgJt5.wR7qk7lFy8dS";

async function hashPassword(plain) {
  return bcrypt.hash(plain, SALT_ROUNDS);
}

async function verifyPassword(plain, hash) {
  return bcrypt.compare(plain, hash || DUMMY_HASH);
}

// Human-relayable random password: no ambiguous characters (0/O, 1/l/I).
function generateTempPassword(length = 10) {
  const alphabet = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789";
  let out = "";
  const bytes = crypto.randomBytes(length);
  for (let i = 0; i < length; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

module.exports = { hashPassword, verifyPassword, generateTempPassword, DUMMY_HASH };
