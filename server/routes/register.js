const express = require("express");
const router = express.Router();
const pool = require("../db");
const bcrypt = require("bcryptjs");
const { v4: uuidv4 } = require("uuid");
const { requireRole, sensitiveCsrf, csrfToken } = require("../middleware/auth");
const { writeAuditEvent } = require("../audit");
const { validateUsername, validatePassword } = require("../staff_security");

router.use(requireRole("admin"));
router.use(sensitiveCsrf);

router.get("/", (req, res) => {
    res.set("Cache-Control", "no-store");
    res.render("register", { error: null, csrfToken: csrfToken(req) });
});

router.post("/", async (req, res) => {
    const { username, password } = req.body || {};
    const validatedUsername = validateUsername(username);
    const passwordError = validatePassword(password);
    if (validatedUsername.error) return res.status(400).render("register", { error: validatedUsername.error, csrfToken: csrfToken(req) });
    if (passwordError) return res.status(400).render("register", { error: passwordError, csrfToken: csrfToken(req) });
    let connection;
    let transactionOpen = false;
    try {
        connection = await pool.getConnection();
        await connection.beginTransaction();
        transactionOpen = true;
        const [existing] = await connection.execute(
            "SELECT id FROM users WHERE username_normalized = ?",
            [validatedUsername.normalized]
        );

        if (existing.length > 0) {
            await connection.rollback();
            transactionOpen = false;
            return res.status(409).render("register", { error: "That username is already in use.", csrfToken: csrfToken(req) });
        }

        const passwordHash = await bcrypt.hash(password, 10);
        const id = uuidv4();
        const createdBy = req.session.user.id;

        await connection.execute(
            `INSERT INTO users
             (id, username, username_normalized, password_hash, role, is_active, created_by)
             VALUES (?, ?, ?, ?, ?, TRUE, ?)`,
            [
                id,
                validatedUsername.username,
                validatedUsername.normalized,
                passwordHash,
                "staff",
                createdBy
            ]
        );
        await writeAuditEvent(connection, {
            actorId: createdBy,
            actorRole: req.session.user.role,
            action: "staff.create",
            targetId: id,
            entityType: "user",
            entityId: id,
            requestId: req.requestId || null,
        });
        await connection.commit();
        transactionOpen = false;
        return res.redirect("/admin/staff?success=Staff+account+created.");
    } catch (err) {
        if (connection && transactionOpen) {
            try {
                await connection.rollback();
            } catch (rollbackError) {
                console.error("Could not roll back staff registration:", rollbackError.code || 'DATABASE_ERROR');
            }
        }
        if (err.code === "ER_DUP_ENTRY") {
            return res.status(409).render("register", { error: "That username is already in use.", csrfToken: csrfToken(req) });
        }
        console.error("Staff registration failed:", err.code || 'DATABASE_ERROR');
        return res.status(500).render("register", { error: "Could not create the account. Please try again.", csrfToken: csrfToken(req) });
    } finally {
        if (connection) connection.release();
    }
});

module.exports = router;