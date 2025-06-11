const mongoose = require('mongoose');

const serverSchema = new mongoose.Schema({
    guildId: { type: String, required: true },
    ip: { type: String, default: 'Not set' },
    monitoring: { type: Boolean, default: false }
});

module.exports = mongoose.model('Server', serverSchema);