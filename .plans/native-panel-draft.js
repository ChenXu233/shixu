/**
 * Browser half of dsh-shixu-channel: contributes the Shixu configuration page.
 *
 * Built the way the official settings pages are built (see the
 * `@deepseek-ai/dsh-client-ui-settings` and `-subagent` READMEs): the page is
 * gated by `ctx.configForms.whileServed`, the Host entry is bound through
 * `ctx.configForms.get`, edits are staged by the shared `SettingsFormModel`,
 * and chrome and controls come from `@deepseek-ai/dsh-client-ui-primitives`.
 *
 * The data path writes the same profile patch row the YAML holds — there is no
 * plugin-private store.
 */
window.__ModuleLoader__.load({
  id: 'dsh-shixu-channel',
  factory: function factory(require) {
    var React = require('react');
    var h = React.createElement;
    var prim = require('@deepseek-ai/dsh-client-ui-primitives');

    var LOCALE_NS = 'shixu';
    var NS = 'shixu-driver-onebot11';
    var inject = ['slots', 'locale', 'remote', 'remote.settings', 'configForms'];

    var MESSAGES = {
      zh: {
        'section.label': '时煦',
        'section.hint': '这里的改动直接写进这个 profile 的配置，与配置文件是同一份数据。',
        'form.unavailable': '正在读取配置…',
        'form.readOnly': '当前配置不可写。',
        'form.saveFailed': '保存失败，请重试。',
        'form.save': '保存',
        'form.saving': '保存中…',
        'form.discard': '放弃修改',
        'field.host': '监听地址',
        'field.host.help': '反向模式下本机监听的地址。0.0.0.0 表示所有网卡。',
        'field.port': '监听端口',
        'field.port.help': '反向模式下本机监听的端口，机器人那边要填同一个。',
        'field.url': '对方地址',
        'field.url.help': '正向模式下要连的 WebSocket 服务端地址。',
        'field.token': '访问令牌',
        'field.token.help': '两端要一致。已设置时不会显示原值，只有重新输入才会覆盖。',
        'restart.note': '连接方向与地址改完要重启实例才生效：驱动在启动时读一次就绑定了。',
      },
      en: {
        'section.label': 'Shixu',
        'section.hint': "Edits here write into this profile's configuration — the same document the YAML holds.",
        'form.unavailable': 'Reading configuration…',
        'form.readOnly': 'This configuration is read-only.',
        'form.saveFailed': 'Save failed, please retry.',
        'form.save': 'Save',
        'form.saving': 'Saving…',
        'form.discard': 'Discard',
        'field.host': 'Listen host',
        'field.host.help': 'Address we listen on in reverse mode. 0.0.0.0 means all interfaces.',
        'field.port': 'Listen port',
        'field.port.help': 'Port we listen on in reverse mode; the bot must use the same one.',
        'field.url': 'Peer URL',
        'field.url.help': 'WebSocket server to connect to in forward mode.',
        'field.token': 'Access token',
        'field.token.help': 'Both ends must match. A stored token is never displayed; type a new one to replace it.',
        'restart.note': 'Direction and address take effect after the instance restarts: the driver binds them once at start.',
      },
    };

    /**
     * Staged editor over one Host entry, mirroring the official controllers:
     * the shared model owns staging, validation and saving; this class only
     * maps the model into the hook surface a slot renderer consumes.
     *
     * @param scope - `ctx.configForms.get` view of the entry.
     */
    function FormController(scope) {
      var form = new prim.SettingsFormModel(scope, [
        prim.settingsTextField('host'),
        prim.settingsNumberField('port'),
        prim.settingsTextField('url'),
      ]);
      this.form = form;
      this.store = form.bind(function () {
        return {
          shell: form.shell(),
          host: form.field('host'),
          port: form.field('port'),
          url: form.field('url'),
        };
      });
    }

    /** Hook surface handed to the slot renderer. */
    FormController.prototype.inject = function () {
      return Object.assign({ hooks: { shixuForm: this.store } }, this.form.actions());
    };

    /** Release the accepted-value subscription owned by this controller. */
    FormController.prototype.dispose = function () {
      this.form.dispose();
    };

    /**
     * Render the page.
     *
     * @param t - translate function bound to this plugin's namespace.
     * @returns the section component.
     */
    function createSection(t) {
      // slot 系统把每个 hook 变成 `use<Name>Form` 这样的 hook prop（`hooks.shixuForm`
      // → `useShixuForm`），并且只能在组件顶层调用，所以这里不分帧。
      return function ShixuSettingsSection(props) {
        var snapshot = props.useShixuForm();
        try {
          return renderSection(props, snapshot);
        } catch (err) {
          // 抛出去的异常会连累整个设置面板，宁可把错误显示出来。
          return h('p', { role: 'status' }, 'shixu panel error: ' + ((err && err.message) || String(err)));
        }
      };

      function renderSection(props, snapshot) {
        if (snapshot === undefined || snapshot === null) {
          return h('p', { role: 'status' }, t('form.unavailable'));
        }

        var shell = snapshot.shell || {};
        function helpOf(key) {
          return { label: t(key), content: h('p', null, t(key)) };
        }

        var fields = ['host', 'port', 'url'].map(function (name) {
          return h(prim.SettingsValueField, Object.assign({
            key: name,
            id: 'shixu-' + name,
            label: t('field.' + name),
            help: helpOf('field.' + name + '.help'),
            numeric: name === 'port',
            onEdit: function (text) { props.edit(name, text); },
          }, snapshot[name] || {}));
        });

        return h(
          prim.SettingsForm,
          {
            state: {
              available: shell.available !== false,
              writable: shell.writable !== false,
              dirty: shell.dirty === true,
              invalid: shell.invalid === true,
              saving: shell.saving === true,
              failed: shell.failed === true,
            },
            labels: {
              unavailable: t('form.unavailable'),
              readOnly: t('form.readOnly'),
              saveFailed: t('form.saveFailed'),
              save: t('form.save'),
              saving: t('form.saving'),
              discard: t('form.discard'),
            },
            onSave: props.save,
            onDiscard: props.discard,
            children: [
              h('p', { key: 'hint' }, t('section.hint')),
              h('div', { key: 'fields' }, fields),
              h('p', { key: 'restart' }, t('restart.note')),
            ],
          }
        );
      };
    }

    /**
     * Register the dictionaries and the settings page once the Host serves our
     * entry: `whileServed` keeps the page absent in deployments that never
     * composed the driver.
     *
     * @param ctx - client root context.
     */
    function apply(ctx) {
      ctx.effect(function () {
        return ctx.locale.register(LOCALE_NS, MESSAGES);
      }, 'shixu: locale dictionaries');

      var t = ctx.locale.bind(LOCALE_NS);
      var Section = createSection(t);

      ctx.effect(function () {
        return ctx.configForms.whileServed([NS], function () {
          var controller = new FormController(ctx.configForms.get(NS));
          var disposeSlot = ctx.slots.inject('settings.section', function () {
            return ctx.slots.register(
              {
                name: 'settings.section',
                id: 'shixu',
                order: 40,
                label: function () {
                  return t('section.label');
                },
                inject: function () {
                  return controller.inject();
                },
              },
              Section
            );
          });
          return function () {
            if (typeof disposeSlot === 'function') disposeSlot();
            controller.dispose();
          };
        });
      }, 'shixu: settings page');
    }

    return { inject: inject, apply: apply };
  },
});
