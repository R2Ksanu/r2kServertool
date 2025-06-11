require('dotenv').config();
const {
    Client, GatewayIntentBits, SlashCommandBuilder, Events,
    ChannelType, EmbedBuilder, ButtonBuilder,
    ActionRowBuilder, ButtonStyle, AttachmentBuilder, REST, Routes
} = require('discord.js');
const fetch = require('node-fetch');
const ping = require('ping');
const express = require('express');
const mongoose = require('mongoose');
const Server = require('./models/Server');

const TOKEN = process.env.BOT_TOKEN;
const GUILD_ID = '1365314109054255124';
const DISCORD_INVITE = 'https://discord.gg/Y9p5W5Bx';
const VPS_IP = '8.8.8.8';

if (!TOKEN) {
    console.error("❌ BOT_TOKEN not found in .env file");
    process.exit(1);
}

const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent]
});

const setupChannels = new Map();
const statusCache = new Map();
const monitoringStatus = new Map();
const serverIPs = new Map();
const permissions = new Map();

mongoose.connect(process.env.MONGODB_URI, { useNewUrlParser: true, useUnifiedTopology: true })
    .then(() => console.log('✅ MongoDB connected for bot'))
    .catch(err => console.error('❌ MongoDB connection error:', err));

client.once(Events.ClientReady, async () => {
    console.log(`✅ Logged in as ${client.user.tag}`);

    const commands = [
        new SlashCommandBuilder()
            .setName('setup')
            .setDescription('Create a status channel for a Minecraft server.')
            .addStringOption(opt =>
                opt.setName('ip')
                    .setDescription('Minecraft server IP (e.g., play.example.com)')
                    .setRequired(true)
            ),
        new SlashCommandBuilder().setName('stop').setDescription('Stop monitoring the server.'),
        new SlashCommandBuilder().setName('start').setDescription('Resume monitoring the server.'),
        new SlashCommandBuilder()
            .setName('msg')
            .setDescription('Send maintenance or stop message.')
            .addStringOption(opt =>
                opt.setName('type')
                    .setDescription('Message type')
                    .setRequired(true)
                    .addChoices(
                        { name: 'Maintenance', value: 'maintenance' },
                        { name: 'Server Stop', value: 'server_stop' }
                    ))
            .addStringOption(opt =>
                opt.setName('time')
                    .setDescription('Estimated time (e.g., 1h, 30m)')
                    .setRequired(true)),
        new SlashCommandBuilder()
            .setName('perm')
            .setDescription('Manage role permissions for commands.')
            .addRoleOption(opt =>
                opt.setName('role')
                    .setDescription('Role to modify permissions for'))
            .addStringOption(opt =>
                opt.setName('permission')
                    .setDescription('Command to set permissions for')
                    .addChoices(
                        { name: 'setup', value: 'setup' },
                        { name: 'stop', value: 'stop' },
                        { name: 'start', value: 'start' },
                        { name: 'msg', value: 'msg' },
                        { name: 'perm', value: 'perm' },
                        { name: 'perm_list', value: 'perm_list' },
                        { name: 'ping', value: 'ping' }
                    ))
            .addStringOption(opt =>
                opt.setName('toggle')
                    .setDescription('Allow or deny the permission')
                    .addChoices({ name: 'Allow', value: 'allow' }, { name: 'Deny', value: 'deny' }))
            .addBooleanOption(opt =>
                opt.setName('reset')
                    .setDescription('Reset all permissions')),
        new SlashCommandBuilder().setName('perm_list').setDescription('List role permissions.'),
        new SlashCommandBuilder().setName('ping').setDescription('Check bot and VPS ping.')
    ].map(cmd => cmd.setDMPermission(false).toJSON());

    await client.application.commands.set(commands, GUILD_ID);
    console.log('📡 Commands registered.');

    // Load server data from MongoDB
    const servers = await Server.find();
    servers.forEach(s => {
        setupChannels.set(s.guildId, s.channelId || '');
        serverIPs.set(s.guildId, s.ip);
        monitoringStatus.set(s.guildId, s.monitoring);
    });

    setInterval(async () => {
        for (const [guildId, channelId] of setupChannels.entries()) {
            if (!monitoringStatus.get(guildId)) continue;

            try {
                const channel = await client.channels.fetch(channelId);
                if (!channel) {
                    console.warn(`⚠️ Channel ${channelId} not found for guild ${guildId}`);
                    continue;
                }

                const ip = serverIPs.get(guildId);
                if (!ip) {
                    console.warn(`⚠️ No IP set for guild ${guildId}`);
                    continue;
                }

                const response = await fetch(`https://api.mcsrvstat.us/2/${ip}`);
                const data = await response.json();

                if (!data || !data.online) {
                    const offlineEmbed = new EmbedBuilder()
                        .setTitle(`🔴 Server Offline`)
                        .setDescription(`**${ip}** is currently offline.`)
                        .setColor(0xff0000)
                        .setTimestamp();
                    await channel.send({ embeds: [offlineEmbed] });
                    continue;
                }

                const status = {
                    status: 'Online',
                    name: data.hostname || ip,
                    players: `${data.players.online}/${data.players.max}`,
                    version: data.version || 'Unknown',
                    motd: Array.isArray(data.motd?.clean) ? data.motd.clean.join('\n') : data.motd?.clean || 'N/A',
                    protocol: String(data.protocol || 'Unknown'),
                    icon: data.icon ? Buffer.from(data.icon.split(',')[1], 'base64') : null
                };

                const msgPayload = formatStatusMessage(status, ip);
                const lastMsgId = statusCache.get(guildId);

                if (lastMsgId) {
                    try {
                        const lastMsg = await channel.messages.fetch(lastMsgId);
                        await lastMsg.edit(msgPayload);
                        continue;
                    } catch {
                        console.log(`ℹ️ Message ${lastMsgId} not found, sending new message`);
                    }
                }

                const sent = await channel.send(msgPayload);
                statusCache.set(guildId, sent.id);
                await Server.findOneAndUpdate({ guildId }, { channelId: channel.id });
            } catch (err) {
                console.error('Monitoring error:', err.message);
            }
        }
    }, 2500);

    // API Server
    const app = express();
    app.use(express.json());

    app.post('/api/setup', async (req, res) => {
        const { guildId, ip } = req.body;
        try {
            const guild = await client.guilds.fetch(guildId);
            const channel = await guild.channels.create({
                name: `mc-${ip.split('.')[0]}-status`,
                type: ChannelType.GuildText,
                reason: 'Minecraft Server Status Channel'
            });
            setupChannels.set(guildId, channel.id);
            serverIPs.set(guildId, ip);
            monitoringStatus.set(guildId, true);
            await Server.findOneAndUpdate(
                { guildId },
                { guildId, ip, monitoring: true, channelId: channel.id },
                { upsert: true }
            );
            res.json({ success: true });
        } catch (err) {
            console.error('API setup error:', err.message);
            res.status(500).json({ error: 'Failed to setup server' });
        }
    });

    app.post('/api/start', async (req, res) => {
        const { guildId } = req.body;
        if (!setupChannels.has(guildId)) {
            return res.status(400).json({ error: 'No server is being monitored' });
        }
        monitoringStatus.set(guildId, true);
        await Server.findOneAndUpdate({ guildId }, { monitoring: true });
        res.json({ success: true });
    });

    app.post('/api/stop', async (req, res) => {
        const { guildId } = req.body;
        if (!setupChannels.has(guildId)) {
            return res.status(400).json({ error: 'No server is being monitored' });
        }
        monitoringStatus.set(guildId, false);
        await Server.findOneAndUpdate({ guildId }, { monitoring: false });
        res.json({ success: true });
    });

    app.post('/api/msg', async (req, res) => {
        const { guildId, type, time } = req.body;
        if (!setupChannels.has(guildId)) {
            return res.status(400).json({ error: 'No status channel found' });
        }
        if (!time.match(/^[0-9]+[hmHM]?$/)) {
            return res.status(400).json({ error: 'Invalid time format' });
        }
        try {
            const channel = await client.channels.fetch(setupChannels.get(guildId));
            const serverIp = serverIPs.get(guildId) || 'Server';
            const embed = new EmbedBuilder()
                .setFooter({ text: 'Announced via Dashboard', iconURL: client.user.displayAvatarURL() })
                .setTimestamp();
            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setLabel('Join Community')
                    .setStyle(ButtonStyle.Link)
                    .setURL(DISCORD_INVITE)
                    .setEmoji('🌐')
            );
            if (type === 'maintenance') {
                embed
                    .setTitle('🛠️ Scheduled Maintenance')
                    .setDescription(`**${serverIp}** is undergoing scheduled maintenance to improve your experience.`)
                    .addFields(
                        { name: '⏰ Estimated Duration', value: time, inline: true },
                        { name: '📢 Status', value: 'Maintenance in Progress', inline: true },
                        { name: 'ℹ️ Details', value: 'We’re upgrading the server to ensure optimal performance. Join our community for updates!' }
                    )
                    .setColor(0xffa500)
                    .setThumbnail('https://i.imgur.com/8W0Z5gN.png');
            } else if (type === 'server_stop') {
                embed
                    .setTitle('🟥 Server Offline')
                    .setDescription(`**${serverIp}** is currently offline for scheduled downtime.`)
                    .addFields(
                        { name: '⏰ Estimated Uptime', value: time, inline: true },
                        { name: '📢 Status', value: 'Server Stopped', inline: true },
                        { name: 'ℹ️ Details', value: 'The server is down temporarily. Stay tuned for updates in our community!' }
                    )
                    .setColor(0xff0000)
                    .setThumbnail('https://i.imgur.com/X7qZ4kN.png');
            }
            await channel.send({ embeds: [embed], components: [row] });
            res.json({ success: true });
        } catch (err) {
            console.error('API msg error:', err.message);
            res.status(500).json({ error: 'Failed to send message' });
        }
    });

    app.listen(3001, () => console.log('🌐 Bot API running on http://localhost:3001'));
});

client.on(Events.InteractionCreate, async interaction => {
    if (!interaction.isChatInputCommand()) return;

    const { commandName, options, guild } = interaction;
    const member = await guild.members.fetch(interaction.user.id);

    if (!hasPermission(guild.id, commandName, member)) {
        return interaction.reply({ content: '⛔ You lack permission to use this command.', ephemeral: true });
    }

    try {
        if (commandName === 'setup') {
            const ip = options.getString('ip').trim();
            if (!ip.match(/^[a-zA-Z0-9.-]+(:[0-9]+)?$/)) {
                return interaction.reply({ content: '❌ Invalid IP format.', ephemeral: true });
            }
            const channel = await guild.channels.create({
                name: `mc-${ip.split('.')[0]}-status`,
                type: ChannelType.GuildText,
                reason: 'Minecraft Server Status Channel'
            });
            setupChannels.set(guild.id, channel.id);
            serverIPs.set(guild.id, ip);
            monitoringStatus.set(guild.id, true);
            await Server.findOneAndUpdate(
                { guildId: guild.id },
                { guildId: guild.id, ip, monitoring: true, channelId: channel.id },
                { upsert: true }
            );
            await interaction.reply({ content: `✅ Now monitoring **${ip}** in ${channel}.`, ephemeral: true });
        }

        else if (commandName === 'stop') {
            if (!setupChannels.has(guild.id)) {
                return interaction.reply({ content: '⚠️ No server is being monitored.', ephemeral: true });
            }
            monitoringStatus.set(guild.id, false);
            await Server.findOneAndUpdate({ guildId: guild.id }, { monitoring: false });
            await interaction.reply({ content: '🛑 Monitoring stopped.', ephemeral: true });
        }

        else if (commandName === 'start') {
            if (!setupChannels.has(guild.id)) {
                return interaction.reply({ content: '⚠️ No server is being monitored. Use /setup first.', ephemeral: true });
            }
            monitoringStatus.set(guild.id, true);
            await Server.findOneAndUpdate({ guildId: guild.id }, { monitoring: true });
            await interaction.reply({ content: '▶️ Monitoring resumed.', ephemeral: true });
        }

        else if (commandName === 'msg') {
            const type = options.getString('type');
            const time = options.getString('time').trim();
            if (!time.match(/^[0-9]+[hmHM]?$/)) {
                return interaction.reply({ content: '❌ Invalid time format. Use e.g., "1h" or "30m".', ephemeral: true });
            }

            const channelId = setupChannels.get(guild.id);
            if (!channelId) {
                return interaction.reply({ content: '⚠️ No status channel found. Use /setup first.', ephemeral: true });
            }

            const channel = await client.channels.fetch(channelId);
            const serverIp = serverIPs.get(guild.id) || 'Server';
            const embed = new EmbedBuilder()
                .setFooter({ text: `Announced by ${interaction.user.tag}`, iconURL: interaction.user.displayAvatarURL() })
                .setTimestamp();
            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setLabel('Join Community')
                    .setStyle(ButtonStyle.Link)
                    .setURL(DISCORD_INVITE)
                    .setEmoji('🌐')
            );

            if (type === 'maintenance') {
                embed
                    .setTitle('🛠️ Scheduled Maintenance')
                    .setDescription(`**${serverIp}** is undergoing scheduled maintenance to improve your experience.`)
                    .addFields(
                        { name: '⏰ Estimated Duration', value: time, inline: true },
                        { name: '📢 Status', value: 'Maintenance in Progress', inline: true },
                        { name: 'ℹ️ Details', value: 'We’re upgrading the server to ensure optimal performance. Join our community for updates!' }
                    )
                    .setColor(0xffa500)
                    .setThumbnail('https://i.imgur.com/8W0Z5gN.png');
            } else if (type === 'server_stop') {
                embed
                    .setTitle('🟥 Server Offline')
                    .setDescription(`**${serverIp}** is currently offline for scheduled downtime.`)
                    .addFields(
                        { name: '⏰ Estimated Uptime', value: time, inline: true },
                        { name: '📢 Status', value: 'Server Stopped', inline: true },
                        { name: 'ℹ️ Details', value: 'The server is down temporarily. Stay tuned for updates in our community!' }
                    )
                    .setColor(0xff0000)
                    .setThumbnail('https://i.imgur.com/X7qZ4kN.png');
            }

            await channel.send({ embeds: [embed], components: [row] });
            await interaction.reply({ content: '📨 Announcement sent to the status channel.', ephemeral: true });
        }

        else if (commandName === 'perm') {
            const role = options.getRole('role');
            const perm = options.getString('permission');
            const toggle = options.getString('toggle');
            const reset = options.getBoolean('reset');

            if (!permissions.has(guild.id)) permissions.set(guild.id, {});

            const guildPerms = permissions.get(guild.id);

            if (reset) {
                permissions.set(guild.id, {});
                return interaction.reply({ content: '🔄 All permissions reset.', ephemeral: true });
            }

            if (!role || !perm || !toggle) {
                return interaction.reply({ content: '❌ Please provide role, permission, and toggle (allow/deny).', ephemeral: true });
            }

            if (!guildPerms[perm]) guildPerms[perm] = new Set();

            if (toggle === 'allow') {
                guildPerms[perm].add(role.id);
                await interaction.reply({ content: `✅ Allowed **${perm}** for <@&${role.id}>.`, ephemeral: true });
            } else {
                guildPerms[perm].delete(role.id);
                await interaction.reply({ content: `⛔ Denied **${perm}** for <@&${role.id}>.`, ephemeral: true });
            }
        }

        else if (commandName === 'perm_list') {
            const guildPerms = permissions.get(guild.id) || {};
            let out = '🔐 **Command Permissions**:\n';

            for (const [cmd, roles] of Object.entries(guildPerms)) {
                out += `\n**${cmd}** ➜ ${[...roles].map(id => `<@&${id}>`).join(', ') || 'None'}`;
            }

            await interaction.reply({ content: out || 'No permissions set.', ephemeral: true });
        }

        else if (commandName === 'ping') {
            const res = await ping.promise.probe(VPS_IP);
            const embed = new EmbedBuilder()
                .setTitle('🏓 Ping Status')
                .addFields(
                    { name: 'Bot Ping', value: `${client.ws.ping}ms`, inline: true },
                    { name: 'VPS Ping', value: `${res.alive ? res.time : 'N/A'}ms`, inline: true }
                )
                .setColor(0x00ff00)
                .setTimestamp();
            await interaction.reply({ embeds: [embed] });
        }

    } catch (err) {
        console.error('Command error:', err.message);
        const msg = '❌ An error occurred. Please try again later.';
        if (interaction.replied || interaction.deferred) {
            await interaction.followUp({ content: msg, ephemeral: true });
        } else {
            await interaction.reply({ content: msg, ephemeral: true });
        }
    }
});

function hasPermission(guildId, commandName, member) {
    const guildPerms = permissions.get(guildId);
    if (!guildPerms || !guildPerms[commandName]) return true;
    return member.roles.cache.some(role => guildPerms[commandName].has(role.id));
}

function formatStatusMessage(status, ip) {
    const embed = new EmbedBuilder()
        .setTitle(`🟢 ${status.name}`)
        .setDescription(`**IP**: \`${ip}\`\n**MOTD**:\n${status.motd.slice(0, 1024) || 'N/A'}`)
        .addFields(
            { name: '📊 Status', value: status.status, inline: true },
            { name: '👥 Players', value: status.players, inline: true },
            { name: '📦 Version', value: status.version, inline: true },
            { name: '🔗 Protocol', value: status.protocol, inline: true }
        )
        .setColor(0x00ff00)
        .setFooter({ text: 'Last Updated' })
        .setTimestamp();

    const files = [];
    if (status.icon) {
        const attachment = new AttachmentBuilder(status.icon, { name: 'server-icon.png' });
        embed.setThumbnail('attachment://server-icon.png');
        files.push(attachment);
    }

    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setLabel('Join Server')
            .setStyle(ButtonStyle.Link)
            .setURL(DISCORD_INVITE)
            .setEmoji('🌐')
    );

    return { embeds: [embed], files, components: [row] };
}

function capitalize(str) {
    return str.charAt(0).toUpperCase() + str.slice(1);
}

process.on('unhandledRejection', err => console.error('Unhandled Rejection:', err));

client.login(TOKEN);