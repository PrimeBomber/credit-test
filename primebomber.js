const TelegramBot = require('node-telegram-bot-api');
const sqlite3 = require('sqlite3').verbose();
const axios = require('axios');
require('dotenv').config();

const token = process.env.TELEGRAM_BOT_TOKEN;
const bot = new TelegramBot(token, { polling: true });
const dbFile = 'bot.db';
const db = new sqlite3.Database(dbFile, (err) => {
    if (err) {
        return console.error(err.message);
    }
    console.log('Connected to the SQLite database.');
    initializeDatabase();
});

function initializeDatabase() {
    db.serialize(() => {
        db.run(`
            CREATE TABLE IF NOT EXISTS users (
                id TEXT PRIMARY KEY,
                credits INTEGER DEFAULT 0,
                emails_sent_today INTEGER DEFAULT 0,
                total_emails_sent INTEGER DEFAULT 0
            )
        `);
        db.run(`
            CREATE TABLE IF NOT EXISTS steps (
                userId TEXT PRIMARY KEY,
                step TEXT,
                email_attempts INTEGER DEFAULT 0,
                email TEXT
            )
        `);
        db.run(`
            CREATE TABLE IF NOT EXISTS keys (
                key TEXT PRIMARY KEY,
                credits INTEGER,
                redeemed_by TEXT,
                redeemed_at DATETIME
            )
        `);
        db.run(`CREATE INDEX IF NOT EXISTS idx_redeemed_by ON keys (redeemed_by)`);
    });
}

process.on('SIGINT', () => {
    db.close((err) => {
        if (err) {
            return console.error(err.message);
        }
        console.log('Closed the database connection.');
        process.exit(0);
    });
});

// Command: /start
bot.onText(/\/start/, (msg) => {
    const userId = msg.from.id.toString();
    const chatId = msg.chat.id;

    // Check if the user already exists in the database
    db.get("SELECT id FROM users WHERE id = ?", [userId], (err, row) => {
        if (err) {
            bot.sendMessage(chatId, "An error occurred while accessing the database. Please try again later.");
            console.error(err.message);
            return;
        }

        // If the user does not exist, create a new user record
        if (!row) {
            db.run("INSERT INTO users (id, credits, emails_sent_today, total_emails_sent) VALUES (?, 0, 0, 0)", [userId], (err) => {
                if (err) {
                    bot.sendMessage(chatId, "An error occurred while creating your account. Please try again later.");
                    console.error(err.message);
                    return;
                }

                // Welcome message for a new user
                bot.sendMessage(chatId, "Welcome! Your account has been created. Use /help to see available commands.");
            });
        } else {
            // Welcome back message for existing users
            bot.sendMessage(chatId, "Welcome back! Use /help to see available commands.");
        }
    });
});


// Command: /send
bot.onText(/\/send/, (msg) => {
    const userId = msg.from.id.toString();

    db.get("SELECT * FROM users WHERE id = ?", userId, (err, user) => {
        if (err) {
            bot.sendMessage(msg.chat.id, "Error accessing your account. Please try again later.");
            return;
        }

        if (!user) {
            bot.sendMessage(msg.chat.id, "Your account is not registered. Please start with /start.");
            return;
        }

        // Check if user has enough credits
        if (user.credits <= 0) {
            bot.sendMessage(msg.chat.id, "You do not have enough credits. Please redeem a key to get more credits.");
            return;
        }

        // Check if user hasn't sent more than 2000 emails in the current day
        if (user.emails_sent_today >= 2000) {
            bot.sendMessage(msg.chat.id, "You've reached your daily limit of 2000 emails. Please wait until tomorrow.");
            return;
        }

        bot.sendMessage(msg.chat.id, "Please enter the target email address:");
        db.run("INSERT OR REPLACE INTO steps (userId, step, email_attempts) VALUES (?, 'input_email', 0)", userId);
    });
});

// Command: /generate (Amount of Emails) (Amount of Keys to generate)
bot.onText(/\/generate (\d+) (\d+)/, (msg, match) => {
    const userId = msg.from.id.toString();
    // This should be adjusted to check if the user is an admin
    // For example, if (admins.includes(userId))
    if (userId === process.env.ADMIN_ID) {
        const emailsPerKey = parseInt(match[1]);
        const numberOfKeys = parseInt(match[2]);

        for (let i = 0; i < numberOfKeys; i++) {
            const key = generateKey();
            db.run("INSERT INTO keys (key, credits) VALUES (?, ?)", [key, emailsPerKey], (err) => {
                if (err) {
                    bot.sendMessage(msg.chat.id, "An error occurred while generating the key.");
                    console.error(err.message);
                } else {
                    bot.sendMessage(msg.chat.id, `Key Generated: ${key}`);
                }
            });
        }
    } else {
        bot.sendMessage(msg.chat.id, "You do not have permission to generate keys.");
    }
});

// Helper function to generate a unique key
function generateKey() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let key = '';
    for (let i = 0; i < 16; i++) {
        key += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return key;
}

// ... Rest of the bot.onText callbacks for handling various commands

// Remember to close the database when the bot shuts down
process.on('SIGINT', () => {
    db.close((err) => {
        if (err) {
            return console.error(err.message);
        }
        console.log('Closed the database connection.');
        process.exit(0);
    });
});
