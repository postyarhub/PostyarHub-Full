"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.roleHasPermission = roleHasPermission;
const ROLE_PERMISSIONS = {
    SUPER_ADMIN: [
        'admin.access', 'admin.users.read', 'admin.payments.read', 'admin.audit.read',
        'admin.audit.manage',
        'admin.platform.read', 'admin.plans.read', 'admin.users.manage', 'admin.plans.manage',
        'admin.settings.manage', 'admin.payments.review', 'admin.broadcast', 'support.tickets.any',
    ],
    SUPPORT: ['admin.access', 'support.tickets.any'],
    USER: [],
};
function roleHasPermission(role, permission) {
    return ROLE_PERMISSIONS[role].includes(permission);
}
