const express = require('express');
const passport = require('passport');
const mongoose = require('mongoose');
const session = require('express-session');
const axios = require('axios');
require('dotenv').config();
require('./config/passport');

const app = express();
const Server = require('./models/Server');

app.set('view engine', 'ejs');
app.use(express.static('public'));
app.use(express.urlencoded({ extended: true }));
app.use(session({
    secret: 'your-secret-key',
    resave: false,
    saveUninitialized: false
}));
app.use(passport.initialize());
app.use(passport.session());

mongoose.connect(process.env.MONGODB_URI, { useNewUrlParser: true, useUnifiedTopology: true })
    .then(() => console.log('✅ MongoDB connected'))
    .catch(err => console.error('❌ MongoDB connection error:', err));

app.get('/', async (req, res) => {
    if (!req.isAuthenticated()) return res.redirect('/login');
    const guildId = process.env.GUILD_ID;
    const server = await Server.findOne({ guildId }) || { ip: 'Not set', monitoring: false };
    res.render('index', { user: req.user, server });
});

app.get('/login', (req, res) => {
    if (req.isAuthenticated()) return res.redirect('/');
    res.render('login');
});

app.get('/auth/discord', passport.authenticate('discord'));

app.get('/auth/discord/callback', passport.authenticate('discord', {
    failureRedirect: '/error'
}), (req, res) => res.redirect('/'));

app.get('/logout', (req, res) => {
    req.logout(() => res.redirect('/login'));
});

app.post('/update', async (req, res) => {
    if (!req.isAuthenticated()) return res.redirect('/login');
    const { ip, action, time } = req.body;
    const guildId = process.env.GUILD_ID;

    try {
        if (action === 'setup' && ip) {
            await Server.findOneAndUpdate(
                { guildId },
                { guildId, ip, monitoring: true },
                { upsert: true }
            );
            await axios.post('http://localhost:3001/api/setup', { guildId, ip });
        } else if (action === 'stop') {
            await Server.findOneAndUpdate({ guildId }, { monitoring: false });
            await axios.post('http://localhost:3001/api/stop', { guildId });
        } else if (action === 'start') {
            await Server.findOneAndUpdate({ guildId }, { monitoring: true });
            await axios.post('http://localhost:3001/api/start', { guildId });
        } else if (action === 'msg' && time) {
            const type = req.body.type || 'maintenance';
            await axios.post('http://localhost:3001/api/msg', { guildId, type, time });
        }
        res.redirect('/');
    } catch (err) {
        console.error('Dashboard error:', err.message);
        res.redirect('/error');
    }
});

app.get('/error', (req, res) => {
    res.render('error', { message: 'An error occurred. Please try again.' });
});

app.listen(3000, () => console.log('🌐 Dashboard running on http://localhost:3000'));