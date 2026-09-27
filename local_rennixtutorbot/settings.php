<?php
defined('MOODLE_INTERNAL') || die();

if ($hassiteconfig) {
    $settings = new admin_settingpage('local_rennixtutorbot', get_string('pluginname', 'local_rennixtutorbot'));
    $ADMIN->add('localplugins', $settings);

    $settings->add(new admin_setting_configpasswordunmask(
        'local_rennixtutorbot/apikey',
        get_string('settings_apikey', 'local_rennixtutorbot'),
        get_string('settings_apikey_desc', 'local_rennixtutorbot'),
        ''
    ));
    $settings->add(new admin_setting_configtext(
        'local_rennixtutorbot/model',
        get_string('settings_model', 'local_rennixtutorbot'),
        get_string('settings_model_desc', 'local_rennixtutorbot'),
        'gpt-4o-mini',
        PARAM_TEXT
    ));

    $settings->add(new admin_setting_heading(
        'local_rennixtutorbot/videotrackingheading',
        get_string('settings_videotracking', 'local_rennixtutorbot'),
        get_string('settings_videotracking_desc', 'local_rennixtutorbot')
    ));
    $settings->add(new admin_setting_configcheckbox(
        'local_rennixtutorbot/enablevideotracking',
        get_string('settings_enablevideotracking', 'local_rennixtutorbot'),
        get_string('settings_enablevideotracking_desc', 'local_rennixtutorbot'),
        1
    ));
    $settings->add(new admin_setting_configtext(
        'local_rennixtutorbot/rennixltiurl',
        get_string('settings_rennixltiurl', 'local_rennixtutorbot'),
        get_string('settings_rennixltiurl_desc', 'local_rennixtutorbot'),
        '',
        PARAM_URL
    ));
}
