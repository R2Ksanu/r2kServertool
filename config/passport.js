const passport = require('passport');
const DiscordStrategy = require('passport-discord').Strategy;
require('dotenv').config();

passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser((obj, done) => done(null, obj));

passport.use(new DiscordStrategy({
    clientID: process.env.CLIENT_ID,
    clientSecret: process.env.CLIENT_SECRET,
    callbackURL: `${process.env.DASHBOARD_URL}/auth/discord/callback`,
    scope: ['identify', 'guilds']
}, async (accessToken, refreshToken, profile, done) => {
    const guild = profile.guilds.find(g => g.id === process.env.GUILD_ID);
    if (!guild || !(new (require('discord.js').PermissionsBitField)(BigInt(guild.permissions)).has('MANAGE_GUILD'))) {
        return done(null, false);
    }
    done(null, profile);
}));